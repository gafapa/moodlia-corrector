// Converts a Word document (DOCX) into pieces for the shared page engine.
// Pages follow the w:lastRenderedPageBreak markers Word stores where it last
// broke pages; without them the document is paginated by measuring the layout.
// Word XML is matched by local name, so unusual prefixes or namespaces still read.
import {
  BORDER, FONT_FAMILY, applyCss, cloneMapped, createImageSources, createLimitations, formatNumber, html, imageLoaded, mappedText, paginateAndRender, placeholder,
} from './pageLayout.js';

const MATHML = 'http://www.w3.org/1998/Math/MathML';
const MAX_TABLE_COLUMNS = 256;
const MAX_TABLE_ELEMENTS = 200_000;
const PT_PER_EMU = 1 / 12700;

const elements = (node) => node ? [...node.childNodes].filter(child => child.nodeType === Node.ELEMENT_NODE) : [];
const child = (node, name) => elements(node).find(element => element.localName === name) || null;
const descendant = (node, name) => node?.getElementsByTagNameNS('*', name)[0] || null;
const val = (node, name = 'val') => {
  for (const attribute of node?.attributes || []) if (attribute.localName === name) return attribute.value;
  return null;
};
const attributes = (node) => Object.fromEntries([...node.attributes].map(attribute => [attribute.localName, attribute.value]));
const isOn = (property) => !!property && !['0', 'false', 'off'].includes(property.val);
const twips = (value) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) / 20 : null;
const pt = (value) => `${Math.round(value * 100) / 100}pt`;
const HEX = /^[0-9a-f]{6}$/i;

// Properties are kept per element name with their attributes, so a direct
// <w:spacing w:before> keeps the style's w:after.
const CONTAINERS = new Set(['pBdr', 'tblBorders', 'tcBorders', 'tblCellMar', 'tcMar', 'numPr']);
const readProps = (element, base = {}) => {
  const props = { ...base };
  for (const property of elements(element)) {
    const name = property.localName;
    if (['rPr', 'sectPr', 'pPrChange', 'rPrChange', 'tblPrChange', 'tcPrChange', 'trPrChange'].includes(name)) continue;
    if (name === 'tabs') {
      const stops = new Map((props.tabs || []).map(stop => [stop.pos, stop]));
      for (const tab of elements(property)) {
        const stop = { val: val(tab), pos: Number(val(tab, 'pos')) };
        if (!Number.isFinite(stop.pos)) continue;
        if (stop.val === 'clear') stops.delete(stop.pos); else stops.set(stop.pos, stop);
      }
      props.tabs = [...stops.values()].sort((a, b) => a.pos - b.pos);
    } else if (CONTAINERS.has(name)) {
      const merged = { ...props[name] };
      for (const part of elements(property)) merged[part.localName] = attributes(part);
      props[name] = merged;
    } else props[name] = { ...props[name], ...attributes(property) };
  }
  return props;
};
const mergeProps = (...layers) => layers.reduce((merged, layer) => {
  if (!layer) return merged;
  const result = { ...merged };
  for (const [name, value] of Object.entries(layer)) {
    result[name] = Array.isArray(value) ? value : CONTAINERS.has(name) ? { ...merged[name], ...value } : { ...merged[name], ...value };
  }
  return result;
}, {});

const HIGHLIGHT = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080',
  darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};
const fontStack = (name) => {
  const clean = (name || '').replace(/['"]/g, '').trim();
  if (!clean || !FONT_FAMILY.test(clean)) return null;
  const generic = /mono|courier|consol/i.test(clean) ? 'monospace' : /sans|arial|calibri|helvetica|verdana|segoe|aptos|tahoma|gothic|trebuchet/i.test(clean) ? 'sans-serif' : 'serif';
  return `'${clean}', ${generic}`;
};
const borderCss = (border) => {
  if (!border) return null;
  if (!border.val || ['nil', 'none'].includes(border.val)) return 'none';
  const width = Math.max(0.25, (Number(border.sz) || 4) / 8);
  const style = border.val === 'double' ? 'double' : /dash/i.test(border.val) ? 'dashed' : /dot/i.test(border.val) ? 'dotted' : 'solid';
  const value = `${width}pt ${style} ${HEX.test(border.color || '') ? `#${border.color}` : '#000000'}`;
  return BORDER.test(value) ? value : null;
};
const shading = (shd) => shd && HEX.test(shd.fill || '') ? `#${shd.fill}` : null;

// Word's single line spacing follows the font's own line height, about 1.15 em (Liberation Serif and Times New Roman: 1.149).
const paragraphCss = (props) => {
  const css = {};
  const align = { left: 'left', start: 'left', right: 'right', end: 'right', center: 'center', both: 'justify', distribute: 'justify' }[props.jc?.val];
  if (align) css['text-align'] = align;
  const spacing = props.spacing || {};
  // Paragraph spacing adds up in Word instead of collapsing, so it is padding.
  const before = spacing.beforeAutospacing === '1' ? 14 : twips(spacing.before);
  const after = spacing.afterAutospacing === '1' ? 14 : twips(spacing.after);
  if (before !== null) css['padding-top'] = pt(Math.max(0, before));
  if (after !== null) css['padding-bottom'] = pt(Math.max(0, after));
  const line = Number(spacing.line);
  if (Number.isFinite(line) && line > 0) {
    if (!spacing.lineRule || spacing.lineRule === 'auto') css['line-height'] = String(Math.round(line / 240 * 1.15 * 1000) / 1000);
    else css['line-height'] = pt(line / 20);
  }
  const indent = props.ind || {};
  const left = twips(indent.left ?? indent.start);
  const right = twips(indent.right ?? indent.end);
  if (left !== null) css['margin-left'] = pt(left);
  if (right !== null) css['margin-right'] = pt(right);
  if (indent.hanging !== undefined && twips(indent.hanging) !== null) css['text-indent'] = pt(-twips(indent.hanging));
  else if (indent.firstLine !== undefined && twips(indent.firstLine) !== null) css['text-indent'] = pt(twips(indent.firstLine));
  for (const [side, name] of [['top', 'top'], ['bottom', 'bottom'], ['left', 'left'], ['right', 'right'], ['start', 'left'], ['end', 'right']]) {
    const border = borderCss(props.pBdr?.[side]);
    if (border) css[`border-${name}`] = border;
  }
  const background = shading(props.shd);
  if (background) css['background-color'] = background;
  return css;
};

// OMML (Word equations) to MathML, and to a linear form for the extracted text.
const MATH_TOKEN = /(\d+(?:[.,]\d+)*)|(\p{L})|(\s+)|(.)/gsu;
const mathTokens = (text, joinLetters) => {
  const nodes = [];
  if (joinLetters && /^\p{L}+$/u.test(text)) {
    const identifier = document.createElementNS(MATHML, 'mi');
    identifier.textContent = text;
    if (text.length > 1) identifier.setAttribute('mathvariant', 'normal');
    return [identifier];
  }
  for (const [, number, letter, , other] of text.matchAll(MATH_TOKEN)) {
    const token = number ? 'mn' : letter ? 'mi' : other ? 'mo' : null;
    if (!token) continue;
    const node = document.createElementNS(MATHML, token);
    node.textContent = number || letter || other;
    nodes.push(node);
  }
  return nodes;
};
const ommlProperty = (node, properties, name) => val(child(child(node, properties), name));
export const ommlToMathml = (node, depth = 0) => {
  const make = (name, ...children) => {
    const element = document.createElementNS(MATHML, name);
    for (const part of children) if (part) element.append(part);
    return element;
  };
  const row = (part, joinLetters = false) => {
    const element = make('mrow');
    for (const item of elements(part)) {
      if (item.localName === 'r') {
        const text = elements(item).filter(token => token.localName === 't').map(token => token.textContent).join('');
        element.append(...mathTokens(text, joinLetters));
      } else {
        const converted = ommlToMathml(item, depth + 1);
        if (converted) element.append(converted);
      }
    }
    return element;
  };
  const argument = (name) => row(child(node, name));
  const operator = (text, extra = {}) => {
    const element = make('mo');
    element.textContent = text;
    for (const [key, value] of Object.entries(extra)) element.setAttribute(key, value);
    return element;
  };
  if (depth > 100) return null;
  switch (node.localName) {
    case 'oMath': case 'e': case 'num': case 'den': case 'sub': case 'sup': case 'deg': case 'lim': case 'box': case 'phant': return row(node);
    case 'fName': return row(node, true);
    case 'f': return ommlProperty(node, 'fPr', 'type') === 'lin'
      ? make('mrow', argument('num'), operator('/'), argument('den'))
      : make('mfrac', argument('num'), argument('den'));
    case 'sSup': return make('msup', argument('e'), argument('sup'));
    case 'sSub': return make('msub', argument('e'), argument('sub'));
    case 'sSubSup': return make('msubsup', argument('e'), argument('sub'), argument('sup'));
    case 'sPre': return make('mrow', make('msubsup', make('mrow'), argument('sub'), argument('sup')), argument('e'));
    case 'rad': {
      const degree = child(node, 'deg');
      return isOn({ val: ommlProperty(node, 'radPr', 'degHide') ?? (child(child(node, 'radPr'), 'degHide') ? '1' : '0') }) || !elements(degree).length
        ? make('msqrt', argument('e')) : make('mroot', argument('e'), argument('deg'));
    }
    case 'd': {
      const properties = child(node, 'dPr');
      const begin = child(properties, 'begChr') ? val(child(properties, 'begChr')) ?? '' : '(';
      const end = child(properties, 'endChr') ? val(child(properties, 'endChr')) ?? '' : ')';
      const separator = child(properties, 'sepChr') ? val(child(properties, 'sepChr')) ?? '' : '|';
      const element = make('mrow');
      if (begin) element.append(operator(begin, { fence: 'true' }));
      elements(node).filter(part => part.localName === 'e').forEach((part, index) => {
        if (index && separator) element.append(operator(separator));
        element.append(row(part));
      });
      if (end) element.append(operator(end, { fence: 'true' }));
      return element;
    }
    case 'nary': {
      const properties = child(node, 'naryPr');
      const symbol = child(properties, 'chr') ? val(child(properties, 'chr')) || '∫' : '∫';
      const base = operator(symbol, { largeop: 'true' });
      const under = child(properties, 'limLoc') ? val(child(properties, 'limLoc')) === 'undOvr' : symbol !== '∫';
      const lower = isOn(child(properties, 'subHide') && { val: val(child(properties, 'subHide')) ?? '1' }) ? null : argument('sub');
      const upper = isOn(child(properties, 'supHide') && { val: val(child(properties, 'supHide')) ?? '1' }) ? null : argument('sup');
      const limits = lower && upper ? make(under ? 'munderover' : 'msubsup', base, lower, upper)
        : lower ? make(under ? 'munder' : 'msub', base, lower) : upper ? make(under ? 'mover' : 'msup', base, upper) : base;
      return make('mrow', limits, argument('e'));
    }
    case 'func': return make('mrow', argument('fName'), operator('⁡'), argument('e'));
    case 'acc': {
      const accent = make('mover', argument('e'), operator(ommlProperty(node, 'accPr', 'chr') || '̂'));
      accent.setAttribute('accent', 'true');
      return accent;
    }
    case 'bar': return ommlProperty(node, 'barPr', 'pos') === 'top' ? make('mover', argument('e'), operator('¯')) : make('munder', argument('e'), operator('_'));
    case 'groupChr': {
      const symbol = operator(ommlProperty(node, 'groupChrPr', 'chr') || '⏟');
      return ommlProperty(node, 'groupChrPr', 'pos') === 'top' ? make('mover', argument('e'), symbol) : make('munder', argument('e'), symbol);
    }
    case 'limLow': return make('munder', argument('e'), argument('lim'));
    case 'limUpp': return make('mover', argument('e'), argument('lim'));
    case 'borderBox': { const box = make('menclose', argument('e')); box.setAttribute('notation', 'box'); return box; }
    case 'm': return make('mtable', ...elements(node).filter(part => part.localName === 'mr')
      .map(matrixRow => make('mtr', ...elements(matrixRow).filter(part => part.localName === 'e').map(cell => make('mtd', row(cell))))));
    case 'eqArr': return make('mtable', ...elements(node).filter(part => part.localName === 'e').map(part => make('mtr', make('mtd', row(part)))));
    default: return node.localName.endsWith('Pr') || node.localName === 'ctrlPr' ? null : row(node);
  }
};
export const ommlToText = (node, depth = 0) => {
  if (depth > 100) return '';
  const text = (part) => elements(part).map(item => item.localName === 't' ? item.textContent : ommlToText(item, depth + 1)).join('');
  const wrap = (value) => [...value].length <= 1 ? value : `(${value})`;
  const argument = (name) => text(child(node, name));
  switch (node.localName) {
    case 'f': return `${wrap(argument('num'))}/${wrap(argument('den'))}`;
    case 'sSup': return `${argument('e')}^${wrap(argument('sup'))}`;
    case 'sSub': return `${argument('e')}_${wrap(argument('sub'))}`;
    case 'sSubSup': return `${argument('e')}_${wrap(argument('sub'))}^${wrap(argument('sup'))}`;
    case 'rad': return elements(child(node, 'deg')).length ? `root(${argument('deg')})(${argument('e')})` : `sqrt(${argument('e')})`;
    case 'd': {
      const properties = child(node, 'dPr');
      const begin = child(properties, 'begChr') ? val(child(properties, 'begChr')) ?? '' : '(';
      const end = child(properties, 'endChr') ? val(child(properties, 'endChr')) ?? '' : ')';
      const separator = child(properties, 'sepChr') ? val(child(properties, 'sepChr')) ?? '' : '|';
      return `${begin}${elements(node).filter(part => part.localName === 'e').map(text).join(separator)}${end}`;
    }
    case 'nary': {
      const symbol = ommlProperty(node, 'naryPr', 'chr') || '∫';
      const lower = argument('sub');
      const upper = argument('sup');
      return `${symbol}${lower ? `_${wrap(lower)}` : ''}${upper ? `^${wrap(upper)}` : ''} ${argument('e')}`;
    }
    case 'func': return `${argument('fName')} ${argument('e')}`;
    case 'limLow': return `${argument('e')}_${wrap(argument('lim'))}`;
    case 'limUpp': return `${argument('e')}^${wrap(argument('lim'))}`;
    case 'm': return `[${elements(node).filter(part => part.localName === 'mr').map(matrixRow => elements(matrixRow).filter(part => part.localName === 'e').map(text).join(', ')).join('; ')}]`;
    case 'eqArr': return elements(node).filter(part => part.localName === 'e').map(text).join('; ');
    case 't': return node.textContent;
    default: return node.localName.endsWith('Pr') ? '' : text(node);
  }
};

// Symbol-font bullets use private-use code points; show their usual shapes.
const SYMBOL_BULLETS = { '': '•', '': '▪', '': '➢', '': '❖', '': '✓', '': '□', '': '■', '': '➔' };
const bulletText = (text) => {
  const character = [...(text || '')][0] || '•';
  if (SYMBOL_BULLETS[character]) return SYMBOL_BULLETS[character];
  const code = character.codePointAt(0);
  return code >= 0xe000 && code <= 0xf8ff ? '•' : character;
};
// FILENAME results are not drawn: requests do not carry original file names.
const fieldKind = (instruction) => /^\s*PAGE\b/i.test(instruction) ? 'page-number' : /^\s*(?:NUMPAGES|SECTIONPAGES)\b/i.test(instruction) ? 'page-count'
  : /^\s*FILENAME\b/i.test(instruction) ? 'suppress' : null;
// A symbol becomes text only when it is a printable character; control codes would break the page image.
const printable = (code) => Number.isInteger(code) && code >= 0x20 && code !== 0x7f && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);

export const renderDocxPages = async ({ entries, parsedParts = new Map(), signal, encodePageImage, sniffFormat, bitmapDimensions, bytesToBase64, maxImageCharacters, maxPixels, pageImages, redact }) => {
  const limitations = createLimitations();
  // Drawn text nodes -> their w:t or w:sym; list paragraphs -> their drawn number or bullet.
  const sourceOf = new WeakMap();
  const listLabels = new Map();
  const imageSource = createImageSources({ entries, sniffFormat, bitmapDimensions, bytesToBase64, maxPixels });
  const pendingImages = [];
  // Parts already parsed by the reader are reused, so page sources are the reader's own nodes.
  const parsed = new Map(parsedParts);
  const parse = (path) => {
    if (!parsed.has(path)) {
      const data = entries[path];
      const doc = data ? new DOMParser().parseFromString(new TextDecoder().decode(data), 'application/xml') : null;
      parsed.set(path, doc && !doc.querySelector('parsererror') ? doc : null);
    }
    return parsed.get(path);
  };
  const document_ = parse('word/document.xml');
  const body = descendant(document_, 'body');
  if (!body) throw new Error('Invalid DOCX XML.');
  // Relationships resolve r:id references from each part (images, headers, notes).
  const relationships = new Map();
  const rels = (part) => {
    if (!relationships.has(part)) {
      const slash = part.lastIndexOf('/');
      const directory = part.slice(0, slash + 1);
      const map = new Map();
      for (const relation of parse(`${directory}_rels/${part.slice(slash + 1)}.rels`)?.getElementsByTagNameNS('*', 'Relationship') || []) {
        const target = val(relation, 'Target') || '';
        const external = val(relation, 'TargetMode') === 'External';
        let path = target;
        if (!external) {
          const segments = (target.startsWith('/') ? target.slice(1) : directory + target).split('/');
          const resolved = [];
          for (const segment of segments) if (segment === '..') resolved.pop(); else if (segment && segment !== '.') resolved.push(segment);
          path = resolved.join('/');
        }
        map.set(val(relation, 'Id'), { path, external, type: val(relation, 'Type') || '' });
      }
      relationships.set(part, map);
    }
    return relationships.get(part);
  };
  const theme = parse([...rels('word/document.xml').values()].find(relation => relation.type.endsWith('/theme'))?.path || 'word/theme/theme1.xml');
  const themeFont = (kind) => val(child(descendant(theme, `${kind}Font`), 'latin'), 'typeface');
  const themeFonts = { minor: themeFont('minor'), major: themeFont('major') };

  // Styles: document defaults, then each style's basedOn chain.
  const stylesDoc = parse('word/styles.xml');
  const styleNodes = new Map();
  const defaultStyles = {};
  for (const style of stylesDoc?.getElementsByTagNameNS('*', 'style') || []) {
    styleNodes.set(val(style, 'styleId'), style);
    if (isOn({ val: val(style, 'default') ?? '0' })) defaultStyles[val(style, 'type')] ||= val(style, 'styleId');
  }
  const docDefaults = descendant(stylesDoc, 'docDefaults');
  const defaults = {
    rPr: readProps(child(child(docDefaults, 'rPrDefault'), 'rPr')),
    pPr: readProps(child(child(docDefaults, 'pPrDefault'), 'pPr')),
  };
  const styleCache = new Map();
  const styleChain = (id, depth = 0) => {
    if (!id) return { pPr: {}, rPr: {}, tblPr: {}, tcPr: {}, trPr: {}, conditional: new Map() };
    if (styleCache.has(id)) return styleCache.get(id);
    const node = styleNodes.get(id);
    const parent = node && depth < 20 && val(child(node, 'basedOn')) ? styleChain(val(child(node, 'basedOn')), depth + 1) : styleChain(null);
    const conditional = new Map(parent.conditional);
    for (const part of elements(node).filter(element => element.localName === 'tblStylePr')) {
      conditional.set(val(part, 'type'), { pPr: readProps(child(part, 'pPr')), rPr: readProps(child(part, 'rPr')), tcPr: readProps(child(part, 'tcPr')) });
    }
    const resolved = node ? {
      pPr: readProps(child(node, 'pPr'), parent.pPr), rPr: readProps(child(node, 'rPr'), parent.rPr),
      tblPr: readProps(child(node, 'tblPr'), parent.tblPr), tcPr: readProps(child(node, 'tcPr'), parent.tcPr), trPr: readProps(child(node, 'trPr'), parent.trPr), conditional,
    } : parent;
    styleCache.set(id, resolved);
    return resolved;
  };

  // Numbering: w:num -> w:abstractNum levels, with level overrides.
  const numberingDoc = parse('word/numbering.xml');
  const abstracts = new Map();
  for (const abstract of numberingDoc?.getElementsByTagNameNS('*', 'abstractNum') || []) abstracts.set(val(abstract, 'abstractNumId'), abstract);
  const nums = new Map();
  for (const num of numberingDoc?.getElementsByTagNameNS('*', 'num') || []) nums.set(val(num, 'numId'), num);
  const numberingLevel = (numId, level, depth = 0) => {
    const num = nums.get(numId);
    if (!num || depth > 5) return null;
    const override = elements(num).find(element => element.localName === 'lvlOverride' && Number(val(element, 'ilvl')) === level);
    let abstract = abstracts.get(val(child(num, 'abstractNumId')));
    const link = val(child(abstract, 'numStyleLink'));
    // A numbering style link points at the w:num that defines the levels.
    if (link) {
      const linked = styleChain(link).pPr.numPr?.numId?.val;
      if (linked && linked !== numId) return numberingLevel(linked, level, depth + 1);
    }
    const definition = child(override, 'lvl') || elements(abstract).find(element => element.localName === 'lvl' && Number(val(element, 'ilvl')) === level);
    if (!definition) return null;
    return {
      definition,
      start: Number(val(child(override, 'startOverride')) ?? val(child(definition, 'start')) ?? 1) || 0,
      restart: !!child(override, 'startOverride'),
      format: val(child(definition, 'numFmt')) || 'decimal',
      text: val(child(definition, 'lvlText')) ?? '',
      suffix: val(child(definition, 'suff')) || 'tab',
      pPr: readProps(child(definition, 'pPr')),
      rPr: readProps(child(definition, 'rPr')),
    };
  };
  // Lists whose w:num has no override share the counters of their abstractNum, so
  // a second w:num of the same definition continues the numbering (as LibreOffice
  // shows Word documents); a w:num with a level override counts on its own.
  const counters = new Map();
  const restarted = new Set();
  const counterKey = (numId) => {
    const num = nums.get(numId);
    return elements(num).some(element => element.localName === 'lvlOverride') ? `num:${numId}` : `abstract:${val(child(num, 'abstractNumId'))}`;
  };
  const listMarker = (numId, level, definition) => {
    const key = counterKey(numId);
    const values = counters.get(key) || [];
    counters.set(key, values);
    if (definition.restart && !restarted.has(`${numId}:${level}`)) { values[level] = undefined; restarted.add(`${numId}:${level}`); }
    values[level] = values[level] === undefined ? definition.start : values[level] + 1;
    values.length = level + 1;
    if (definition.format === 'bullet') return bulletText(definition.text);
    if (definition.format === 'none') return '';
    return definition.text.replace(/%([1-9])/g, (_, digit) => {
      const index = Number(digit) - 1;
      const levelDefinition = index === level ? definition : numberingLevel(numId, index);
      const format = levelDefinition?.format || 'decimal';
      return formatNumber(values[index] ?? levelDefinition?.start ?? 1, ['decimal', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman', 'decimalZero'].includes(format) ? format : 'decimal');
    });
  };

  const runCss = (props) => {
    const css = {};
    if (props.b) css['font-weight'] = isOn(props.b) ? 'bold' : 'normal';
    if (props.i) css['font-style'] = isOn(props.i) ? 'italic' : 'normal';
    const lines = [];
    if (props.u && props.u.val !== 'none' && isOn(props.u)) lines.push('underline');
    if (isOn(props.strike) || isOn(props.dstrike)) lines.push('line-through');
    if (lines.length) css['text-decoration-line'] = lines.join(' ');
    if (isOn(props.caps)) css['text-transform'] = 'uppercase';
    if (isOn(props.smallCaps)) css['font-variant'] = 'small-caps';
    const size = Number(props.sz?.val);
    if (Number.isFinite(size) && size > 0) css['font-size'] = pt(size / 2);
    if (HEX.test(props.color?.val || '')) css.color = `#${props.color.val}`;
    const background = HIGHLIGHT[props.highlight?.val] || shading(props.shd);
    if (background) css['background-color'] = background;
    const fonts = props.rFonts || {};
    const themed = (fonts.asciiTheme || fonts.hAnsiTheme || '').startsWith('major') ? themeFonts.major : (fonts.asciiTheme || fonts.hAnsiTheme) ? themeFonts.minor : null;
    const family = fontStack(themed || fonts.ascii || fonts.hAnsi);
    if (family) css['font-family'] = family;
    if (['superscript', 'subscript'].includes(props.vertAlign?.val)) {
      css['vertical-align'] = props.vertAlign.val === 'superscript' ? 'super' : 'sub';
      css['font-size'] = Number.isFinite(size) && size > 0 ? pt(size / 2 * 0.65) : '65%';
    }
    if (isOn(props.vanish)) css.display = 'none';
    const spacing = twips(props.spacing?.val);
    if (spacing) css['letter-spacing'] = pt(spacing);
    return css;
  };

  // Conversion state: the XML part being read (for relationships), footnotes
  // collected for the current piece, table style layers, open fields and notes.
  const context = { part: 'word/document.xml', tableElements: 0, notes: null, table: null, fields: [], footnotes: 0, endnotes: [], endnoteCount: 0, noteLabel: null, previous: null, contentWidth: 451, pageLeft: 72 };
  const noteParts = { footnote: parse('word/footnotes.xml'), endnote: parse('word/endnotes.xml') };
  const noteIndex = Object.fromEntries(Object.entries(noteParts).map(([kind, doc]) => [kind, new Map([...doc?.getElementsByTagNameNS('*', kind) || []].map(note => [val(note, 'id'), note]))]));
  const noteBody = (kind, id) => noteIndex[kind].get(id) || null;

  const image = (relationId, widthPt, heightPt, inline) => {
    const relation = rels(context.part).get(relationId);
    const source = !relation ? { format: 'unknown', limitation: 'unsupported-embedded-image-format' }
      : relation.external ? { format: 'link', limitation: 'external-linked-image' } : imageSource(relation.path);
    const box = applyCss(html('span'), { display: inline ? 'inline-block' : 'block', 'vertical-align': 'baseline', 'max-width': '100%', ...(widthPt ? { width: pt(widthPt) } : {}) });
    if (source.src) {
      const element = html('img');
      element.src = source.src;
      pendingImages.push(imageLoaded(element));
      applyCss(element, { width: widthPt ? '100%' : 'auto', ...(widthPt && heightPt ? { height: pt(heightPt) } : {}), 'object-fit': 'contain' });
      box.append(element);
      return box;
    }
    limitations.add(source.limitation, source.format);
    box.append(placeholder(`[Image not shown: ${source.format.toUpperCase()}]`, widthPt ? '100%' : null, heightPt ? pt(heightPt) : null));
    return box;
  };
  // A text box's own paragraphs set their alignment; the box does not inherit the
  // justification, first-line indent or line spacing of the paragraph it is anchored in.
  const textBox = (content, widthPt, heightPt = null, look = {}) => {
    const box = applyCss(html('span'), {
      display: 'inline-block', 'vertical-align': 'top', border: look.border ?? '0.75pt solid #000000', padding: look.padding || '3.6pt 7.2pt', 'box-sizing': 'border-box',
      'text-align': 'left', 'text-indent': '0', 'line-height': 'normal', ...(look.fill ? { 'background-color': look.fill } : {}), ...(widthPt ? { width: pt(widthPt) } : {}), ...(heightPt ? { 'min-height': pt(heightPt) } : {}),
    });
    convertBlocks(content, box);
    return box;
  };
  // DrawingML shape fill, outline and text insets (wps:spPr, wps:bodyPr); only literal sRGB colours are drawn.
  const shapeLook = (shape) => {
    const properties = child(shape, 'spPr');
    const rgb = (node) => { const value = val(child(child(node, 'solidFill'), 'srgbClr')); return HEX.test(value || '') ? `#${value}` : null; };
    const look = {};
    if (child(properties, 'noFill')) look.fill = null; else if (rgb(properties)) look.fill = rgb(properties);
    const line = child(properties, 'ln');
    if (line) {
      const width = Math.max(0.5, Math.min(20, (Number(val(line, 'w')) || 0) * PT_PER_EMU));
      look.border = child(line, 'noFill') ? 'none' : rgb(line) ? `${Math.round(width * 100) / 100}pt solid ${rgb(line)}` : undefined;
      if (look.border && !BORDER.test(look.border)) delete look.border;
    }
    const body = child(shape, 'bodyPr');
    const inset = (name, fallback) => { const value = Number(val(body, name)); return pt(Number.isFinite(value) && val(body, name) !== null ? Math.max(0, Math.min(value * PT_PER_EMU, 72)) : fallback); };
    if (body) look.padding = `${inset('tIns', 3.6)} ${inset('rIns', 7.2)} ${inset('bIns', 3.6)} ${inset('lIns', 7.2)}`;
    return look;
  };
  // VML fill and stroke: fillcolor/filled and strokecolor/stroked, or their v:fill and v:stroke children.
  const vmlLook = (shape) => {
    const color = (value) => /^#[0-9a-f]{6}$/i.test((value || '').trim()) ? value.trim().toLowerCase() : null;
    const off = (value) => ['f', 'false', '0'].includes((value || '').trim().toLowerCase());
    const look = {};
    const fill = color(shape?.getAttribute('fillcolor')) || color(val(child(shape, 'fill'), 'color'));
    if (off(shape?.getAttribute('filled'))) look.fill = null; else if (fill) look.fill = fill;
    const stroke = color(shape?.getAttribute('strokecolor')) || color(val(child(shape, 'stroke'), 'color'));
    if (off(shape?.getAttribute('stroked'))) look.border = 'none'; else if (stroke) look.border = `0.75pt solid ${stroke}`;
    return look;
  };
  const graphic = (data, widthPt, heightPt, inline) => {
    const content = elements(data)[0];
    const name = content?.localName;
    if (name === 'pic') return image(val(descendant(content, 'blip'), 'embed') || val(descendant(content, 'blip'), 'link'), widthPt, heightPt, inline);
    if (name === 'wsp') {
      const text = descendant(content, 'txbxContent');
      if (text) return textBox(text, widthPt, inline ? null : heightPt, shapeLook(content));
      limitations.add('unsupported-embedded-object', 'drawing');
      return null;
    }
    if (['wgp', 'grpSp', 'wpc', 'lockedCanvas'].includes(name)) {
      const group = applyCss(html('span'), { display: inline ? 'inline-block' : 'block' });
      for (const part of content.getElementsByTagNameNS('*', 'pic')) group.append(image(val(descendant(part, 'blip'), 'embed'), null, null, false));
      for (const text of content.getElementsByTagNameNS('*', 'txbxContent')) group.append(textBox(text, null));
      if (!group.childNodes.length) limitations.add('unsupported-embedded-object', 'drawing');
      return group.childNodes.length ? group : null;
    }
    const kind = name === 'chart' ? 'chart' : name === 'relIds' ? 'diagram' : 'object';
    limitations.add('unsupported-embedded-object', kind);
    return placeholder(`[${kind === 'chart' ? 'Chart' : kind === 'diagram' ? 'Diagram' : 'Embedded object'} not shown]`, widthPt ? pt(widthPt) : null, heightPt ? pt(heightPt) : null);
  };
  const drawing = (node) => {
    const anchor = child(node, 'inline') || child(node, 'anchor');
    if (!anchor) return null;
    const extent = child(anchor, 'extent');
    const widthPt = Number(val(extent, 'cx')) * PT_PER_EMU || null;
    const heightPt = Number(val(extent, 'cy')) * PT_PER_EMU || null;
    const inline = anchor.localName === 'inline';
    const converted = graphic(descendant(anchor, 'graphicData'), widthPt, heightPt, inline);
    if (converted && !inline) placeAnchored(converted, anchor, widthPt, heightPt);
    return converted;
  };
  // Anchored drawings: square, tight and through wrapping become a float on the side
  // the drawing sits (text flows beside it), top-and-bottom a block, and no wrapping
  // a box positioned over (or behind) the paragraph it is anchored to.
  const emu = (value) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Math.max(-1584, Math.min(1584, Number(value) * PT_PER_EMU)) : null;
  const placeAnchored = (element, anchor, widthPt, heightPt) => {
    const wrap = elements(anchor).find(item => item.localName.startsWith('wrap'))?.localName || 'wrapNone';
    const horizontal = child(anchor, 'positionH');
    const vertical = child(anchor, 'positionV');
    const align = (val(child(horizontal, 'align')) ?? child(horizontal, 'align')?.textContent ?? '').trim();
    // Horizontal offsets are kept relative to the text column; page offsets lose the left margin.
    let offset = emu(child(horizontal, 'posOffset')?.textContent?.trim());
    if (offset !== null && ['page', 'leftMargin', 'insideMargin', 'outsideMargin'].includes(val(horizontal, 'relativeFrom'))) offset -= context.pageLeft;
    const top = ['paragraph', 'line'].includes(val(vertical, 'relativeFrom') || 'paragraph') ? emu(child(vertical, 'posOffset')?.textContent?.trim()) || 0 : 0;
    const distance = (name) => pt(Math.max(0, emu(val(anchor, name)) || 0));
    const width = widthPt || 0;
    const side = align === 'right' || align === 'outside' ? 'right' : align === 'left' || align === 'inside' ? 'left' : align === 'center' ? 'center'
      : offset === null ? 'left' : offset + width / 2 > context.contentWidth / 2 ? 'right' : 'left';
    const blockAlign = side === 'center' ? { 'margin-left': 'auto', 'margin-right': 'auto' } : side === 'right' ? { 'margin-left': 'auto' }
      : offset > 0 ? { 'margin-left': pt(Math.min(offset, Math.max(0, context.contentWidth - width))) } : {};
    if (['wrapSquare', 'wrapTight', 'wrapThrough'].includes(wrap) && side !== 'center') {
      const inset = side === 'right' ? (offset !== null && !align ? Math.max(0, context.contentWidth - offset - width) : 0) : Math.max(0, offset || 0);
      applyCss(element, {
        display: 'block', float: side, 'max-width': '100%',
        'margin-top': pt(Math.max(0, top) + Math.max(0, emu(val(anchor, 'distT')) || 0)), 'margin-bottom': distance('distB'),
        [`margin-${side === 'right' ? 'left' : 'right'}`]: distance(side === 'right' ? 'distL' : 'distR'), [`margin-${side}`]: pt(inset),
      });
      element.dataset.anchored = 'float';
    } else if (wrap === 'wrapNone' && paragraphState.element) {
      // Absolutely placed against the paragraph; behind the text when behindDoc says so.
      const left = side === 'center' ? Math.max(0, (context.contentWidth - width) / 2) : side === 'right' ? Math.max(0, context.contentWidth - width) : offset || 0;
      applyCss(paragraphState.element, { position: 'relative', ...(isOn({ val: val(anchor, 'behindDoc') ?? '0' }) ? { 'z-index': '0' } : {}) });
      applyCss(element, { display: 'block', position: 'absolute', left: pt(left), top: pt(top), 'text-indent': '0', ...(isOn({ val: val(anchor, 'behindDoc') ?? '0' }) ? { 'z-index': '-1' } : {}) });
      element.dataset.anchored = 'absolute';
    } else {
      applyCss(element, { display: 'block', 'margin-top': distance('distT'), 'margin-bottom': distance('distB'), ...blockAlign });
      element.dataset.anchored = 'block';
    }
    return element;
  };
  const vmlSize = (shape, name) => {
    const match = (shape?.getAttribute('style') || '').match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([\\d.]+)(pt|in|px)`, 'i'));
    return match ? Number(match[1]) * ({ pt: 1, in: 72, px: 0.75 }[match[2].toLowerCase()]) : null;
  };
  const vml = (node, object = false) => {
    const shape = elements(node).find(element => ['shape', 'rect', 'roundrect', 'oval', 'group'].includes(element.localName));
    const data = descendant(node, 'imagedata');
    const text = descendant(node, 'txbxContent');
    if (text) {
      const box = textBox(text, vmlSize(shape, 'width'), null, vmlLook(shape));
      // A floating VML shape (position:absolute) with square or tight wrapping floats to its side.
      const style = shape?.getAttribute('style') || '';
      const wrap = val(descendant(shape, 'wrap'), 'type');
      if (/(?:^|;)\s*position\s*:\s*absolute/i.test(style) && ['square', 'tight', 'through'].includes(wrap)) {
        const side = /mso-position-horizontal\s*:\s*right/i.test(style) ? 'right' : 'left';
        applyCss(box, { display: 'block', float: side, [`margin-${side === 'right' ? 'left' : 'right'}`]: '9pt', 'margin-bottom': '4pt' });
        box.dataset.anchored = 'float';
      } else if (/(?:^|;)\s*position\s*:\s*absolute/i.test(style) && wrap === 'topAndBottom') applyCss(box, { display: 'block', margin: '4pt auto' });
      return box;
    }
    if (data) {
      const relation = rels(context.part).get(val(data, 'id'));
      if (object && relation && !relation.external && !imageSource(relation.path).src) {
        limitations.add('unsupported-embedded-object', 'object');
        return placeholder('[Embedded object not shown]', vmlSize(shape, 'width') ? pt(vmlSize(shape, 'width')) : null, vmlSize(shape, 'height') ? pt(vmlSize(shape, 'height')) : null);
      }
      return image(val(data, 'id'), vmlSize(shape, 'width'), vmlSize(shape, 'height'), true);
    }
    limitations.add('unsupported-embedded-object', object ? 'object' : 'drawing');
    return null;
  };
  const math = (node, display) => {
    const element = document.createElementNS(MATHML, 'math');
    if (display) element.setAttribute('display', 'block');
    const converted = ommlToMathml(node);
    if (converted) element.append(converted);
    return element;
  };
  const note = (reference, kind) => {
    const label = kind === 'footnote' ? String(++context.footnotes) : formatNumber(++context.endnoteCount, 'lowerRoman');
    const source = noteBody(kind, val(reference, 'id'));
    if (source && (kind === 'endnote' || context.notes)) {
      const container = html('div', 'doc-note');
      const saved = { part: context.part, label: context.noteLabel, previous: context.previous, notes: context.notes };
      Object.assign(context, { part: `word/${kind}s.xml`, noteLabel: label, previous: null, notes: null });
      convertBlocks(source, container);
      Object.assign(context, { part: saved.part, noteLabel: saved.label, previous: saved.previous, notes: saved.notes });
      if (kind === 'footnote') context.notes.push(container); else context.endnotes.push({ element: container, source });
    }
    return label;
  };

  // Inline content is emitted into the paragraph's current target; a tab to a
  // centre or right stop starts a positioned segment (headers and footers).
  const paragraphState = { target: null };
  const emit = (node) => { if (node) paragraphState.target.append(node); };
  const startSegment = (stop) => {
    const paragraph = paragraphState.element;
    paragraph.style.position = 'relative';
    const offset = stop.pos / 20 - paragraphState.indent;
    const segment = applyCss(html('span'), {
      position: 'absolute', top: '0', left: pt(offset), 'white-space': 'pre',
      transform: ['center'].includes(stop.val) ? 'translateX(-50%)' : ['right', 'end', 'decimal'].includes(stop.val) ? 'translateX(-100%)' : 'none',
    });
    paragraph.append(segment);
    paragraphState.target = segment;
  };
  const run = (node, base) => {
    const properties = child(node, 'rPr');
    const props = readProps(properties, mergeProps(base, styleChain(val(child(properties, 'rStyle'))).rPr));
    const css = runCss(props);
    let span = null;
    const target = () => {
      if (!span) {
        span = applyCss(html('span'), css);
        paragraphState.target.append(span);
      }
      return span;
    };
    const hidden = () => context.fields.some(field => field.phase === 'instruction' || field.suppress);
    const visit = (items) => {
      for (const item of items) {
        const name = item.localName;
        if (name === 'fldChar') {
          const type = val(item, 'fldCharType');
          if (type === 'begin') context.fields.push({ instruction: '', phase: 'instruction' });
          else if (type === 'separate' && context.fields.length) {
            const field = context.fields.at(-1);
            field.phase = 'result';
            const kind = !context.fields.slice(0, -1).some(open => open.suppress) && fieldKind(field.instruction);
            if (kind === 'suppress') field.suppress = true;
            else if (kind) {
              const value = applyCss(html('span'), css);
              value.dataset.pageField = kind;
              value.textContent = '1';
              paragraphState.target.append(value);
              field.suppress = true;
              span = null;
            }
          } else if (type === 'end') context.fields.pop();
          continue;
        }
        if (name === 'instrText') {
          const field = context.fields.at(-1);
          if (field?.phase === 'instruction') field.instruction += item.textContent;
          continue;
        }
        if (hidden()) continue;
        if (name === 't') target().append(mappedText(item.textContent, item, sourceOf));
        else if (name === 'tab') {
          const stop = paragraphState.stops?.[paragraphState.stopIndex];
          if (stop) { paragraphState.stopIndex++; startSegment(stop); span = null; } else target().append('\t');
        } else if (name === 'ptab') {
          const alignment = val(item, 'alignment');
          if (['center', 'right'].includes(alignment)) {
            startSegment({ val: alignment, pos: (alignment === 'center' ? context.contentWidth / 2 : context.contentWidth) * 20 + paragraphState.indent * 20 });
            span = null;
          } else target().append('\t');
        } else if (name === 'br' || name === 'cr') {
          if (!['page', 'column'].includes(val(item, 'type'))) target().append(html('br'));
        } else if (name === 'noBreakHyphen') target().append('‑');
        else if (name === 'softHyphen') target().append('­');
        else if (name === 'sym') {
          const code = parseInt(val(item, 'char') || '', 16);
          if (printable(code)) target().append(mappedText(code >= 0xf000 && code <= 0xf0ff ? bulletText(String.fromCodePoint(code)) : String.fromCodePoint(code), item, sourceOf));
        } else if (name === 'drawing') { const converted = drawing(item); if (converted) target().append(converted); }
        else if (name === 'pict') { const converted = vml(item); if (converted) target().append(converted); }
        else if (name === 'object') { const converted = vml(item, true); if (converted) target().append(converted); }
        else if (name === 'footnoteReference' || name === 'endnoteReference') {
          const label = note(item, name === 'footnoteReference' ? 'footnote' : 'endnote');
          if (css['vertical-align']) target().append(label);
          else { const mark = html('sup'); mark.textContent = label; target().append(mark); }
        } else if (name === 'footnoteRef' || name === 'endnoteRef') {
          if (context.noteLabel) target().append(css['vertical-align'] ? context.noteLabel : Object.assign(html('sup'), { textContent: context.noteLabel }));
        } else if (name === 'AlternateContent') visit(elements(child(item, 'Choice') || child(item, 'Fallback')));
      }
    };
    visit(elements(node));
  };
  const inline = (node, base) => {
    for (const item of elements(node)) {
      const name = item.localName;
      if (name === 'r') run(item, base);
      else if (['hyperlink', 'ins', 'moveTo', 'smartTag', 'customXml', 'dir', 'bdo'].includes(name)) inline(item, base);
      else if (name === 'sdt') inline(child(item, 'sdtContent'), base);
      else if (name === 'fldSimple') {
        const kind = fieldKind(val(item, 'instr') || '');
        if (kind === 'suppress') continue;
        if (kind) {
          const value = applyCss(html('span'), runCss(readProps(descendant(item, 'rPr'), base)));
          value.dataset.pageField = kind;
          value.textContent = '1';
          emit(value);
        } else inline(item, base);
      } else if (name === 'oMath') emit(math(item, false));
      else if (name === 'oMathPara') for (const equation of elements(item).filter(part => part.localName === 'oMath')) emit(math(equation, true));
      else if (name === 'AlternateContent') inline(child(item, 'Choice') || child(item, 'Fallback'), base);
    }
  };
  const hasVisibleContent = (node) => [...node.getElementsByTagNameNS('*', 't')].some(text => text.textContent) ||
    ['drawing', 'pict', 'object', 'oMath', 'tab', 'sym'].some(name => node.getElementsByTagNameNS('*', name).length);

  const paragraph = (node) => {
    const properties = child(node, 'pPr');
    const styleId = val(child(properties, 'pStyle')) || defaultStyles.paragraph;
    const style = styleChain(styleId);
    const base = mergeProps(defaults.pPr, context.table?.pPr, style.pPr);
    const numbering = readProps(properties, base).numPr;
    const numId = numbering?.numId?.val;
    const level = Math.min(8, Math.max(0, Number(numbering?.ilvl?.val) || 0));
    const definition = numId && numId !== '0' ? numberingLevel(numId, level) : null;
    const props = readProps(properties, mergeProps(base, definition?.pPr));
    const runBase = mergeProps(defaults.rPr, context.table?.rPr, style.rPr);
    const element = applyCss(html('p'), { ...runCss(runBase), ...paragraphCss(props) });
    // Contextual spacing removes the space between paragraphs of the same style.
    if (props.contextualSpacing && isOn(props.contextualSpacing) && context.previous?.styleId === styleId) {
      element.style.paddingTop = '0';
      context.previous.element.style.paddingBottom = '0';
    }
    context.previous = { styleId, element };
    // An empty paragraph keeps the height of its paragraph mark.
    if (!hasVisibleContent(node)) applyCss(element, runCss(readProps(child(properties, 'rPr'), runBase)));
    const indent = twips(props.ind?.left ?? props.ind?.start) || 0;
    const stops = (props.tabs || []).filter(stop => stop.val !== 'bar');
    const saved = { ...paragraphState };
    Object.assign(paragraphState, {
      element, target: element, indent, stopIndex: 0,
      stops: stops.some(stop => ['center', 'right', 'end', 'decimal'].includes(stop.val)) ? stops.filter(stop => stop.pos / 20 > indent) : null,
    });
    if (paragraphState.stops) element.append('​');
    if (definition) {
      const marker = listMarker(numId, level, definition);
      if (marker) {
        listLabels.set(node, marker);
        const hanging = twips(props.ind?.hanging) || 0;
        // Bullet characters were mapped from symbol fonts, so the marker keeps the paragraph font.
        const label = applyCss(html('span'), { ...runCss(mergeProps(runBase, definition.rPr)), 'text-indent': '0', 'font-family': 'inherit' });
        label.textContent = definition.suffix === 'space' ? `${marker} ` : marker;
        if (definition.suffix === 'tab' && hanging > 0) applyCss(label, { display: 'inline-block', 'min-width': pt(hanging) });
        else if (definition.suffix === 'tab') label.textContent = `${marker}\t`;
        element.append(label);
      }
    }
    inline(node, runBase);
    Object.assign(paragraphState, saved);
    // A paragraph holding only a picture or text box with text above and below keeps its own (empty) line under it.
    if (element.querySelector('[data-anchored="block"]') && !element.textContent.replace(/​/g, '').trim()) element.append('​');
    // Word sizes a line by its runs; in CSS the paragraph's own font also sets a minimum
    // line height. When every run is smaller than the paragraph style, use the largest run.
    const own = parseFloat(element.style.fontSize);
    const sizes = [...element.querySelectorAll('span')].filter(span => [...span.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.data.trim()))
      .map(span => span.style.fontSize.endsWith('pt') ? parseFloat(span.style.fontSize) : NaN);
    if (element.style.fontSize.endsWith('pt') && sizes.length && sizes.every(Number.isFinite) && Math.max(...sizes) < own) element.style.fontSize = pt(Math.max(...sizes));
    return element;
  };

  const tableModel = (table) => {
    const properties = child(table, 'tblPr');
    const styleId = val(child(properties, 'tblStyle')) || defaultStyles.table;
    const style = styleChain(styleId);
    const props = readProps(properties, style.tblPr);
    const look = child(properties, 'tblLook');
    const lookValue = parseInt(val(look) || '0', 16) || 0;
    const flag = (name, bit) => val(look, name) !== null ? val(look, name) === '1' : !!(lookValue & bit);
    const looks = { firstRow: flag('firstRow', 0x20), lastRow: flag('lastRow', 0x40), firstColumn: flag('firstColumn', 0x80), lastColumn: flag('lastColumn', 0x100), noHBand: flag('noHBand', 0x200) };
    const grid = elements(child(table, 'tblGrid')).filter(column => column.localName === 'gridCol').slice(0, MAX_TABLE_COLUMNS).map(column => twips(val(column, 'w')) || 0);
    const rows = [];
    const collect = (node) => {
      for (const item of elements(node)) {
        if (item.localName === 'tr') rows.push(item);
        else if (['sdt', 'customXml'].includes(item.localName)) collect(item.localName === 'sdt' ? child(item, 'sdtContent') : item);
      }
    };
    collect(table);
    const cellsOf = (row) => {
      const cells = [];
      const visit = (node) => {
        for (const item of elements(node)) {
          if (item.localName === 'tc') cells.push(item);
          else if (['sdt', 'customXml'].includes(item.localName)) visit(item.localName === 'sdt' ? child(item, 'sdtContent') : item);
        }
      };
      visit(row);
      return cells;
    };
    // Grid positions give vertical merges their row spans.
    const layout = new Map();
    const columnCount = Math.max(grid.length, 1);
    rows.forEach((row, rowIndex) => {
      let column = Number(val(child(child(row, 'trPr'), 'gridBefore'))) || 0;
      for (const cell of cellsOf(row)) {
        const span = Math.max(1, Number(val(child(child(cell, 'tcPr'), 'gridSpan'))) || 1);
        layout.set(cell, { row: rowIndex, column, span, rowSpan: 1, skip: false });
        column += span;
      }
    });
    for (const [cell, place] of layout) {
      if (val(child(child(cell, 'tcPr'), 'vMerge')) !== 'restart') continue;
      for (let next = place.row + 1; next < rows.length; next++) {
        const continued = cellsOf(rows[next]).find(candidate => layout.get(candidate).column === place.column);
        const merge = child(child(continued, 'tcPr'), 'vMerge');
        if (!continued || !merge || val(merge) === 'restart') break;
        layout.get(continued).skip = true;
        place.rowSpan++;
      }
    }
    const header = [];
    for (const row of rows) if (isOn(child(child(row, 'trPr'), 'tblHeader') && { val: val(child(child(row, 'trPr'), 'tblHeader')) ?? '1' })) header.push(row); else break;
    const tableCss = {};
    const width = props.tblW || {};
    if (width.type === 'dxa' && twips(width.w)) tableCss.width = pt(twips(width.w));
    else if (width.type === 'pct' && /^\d+(?:\.\d+)?%?$/.test(width.w || '')) tableCss.width = width.w.endsWith('%') ? width.w : `${Number(width.w) / 50}%`;
    else if (grid.length && grid.every(Boolean)) tableCss.width = pt(grid.reduce((sum, value) => sum + value, 0));
    if (grid.length && grid.every(Boolean)) tableCss['table-layout'] = 'fixed';
    if (props.jc?.val === 'center') Object.assign(tableCss, { 'margin-left': 'auto', 'margin-right': 'auto' });
    else if (['right', 'end'].includes(props.jc?.val)) tableCss['margin-left'] = 'auto';
    else if (twips(props.tblInd?.w)) tableCss['margin-left'] = pt(twips(props.tblInd.w));
    const borders = props.tblBorders || {};
    const margins = props.tblCellMar || {};
    const rowIndexes = new Map(rows.map((row, index) => [row, index]));
    const convertRow = (row) => {
      const rowIndex = rowIndexes.get(row);
      const element = html('tr');
      const height = twips(val(child(child(row, 'trPr'), 'trHeight')));
      if (height) element.style.height = pt(height);
      const before = Number(val(child(child(row, 'trPr'), 'gridBefore'))) || 0;
      if (before) { const spacer = html('td'); spacer.colSpan = before; element.append(spacer); }
      const dataRow = rowIndex - (looks.firstRow ? 1 : 0);
      for (const cell of cellsOf(row)) {
        const place = layout.get(cell);
        if (place.skip) continue;
        const layers = [];
        if (!looks.noHBand && dataRow >= 0 && !(looks.firstRow && rowIndex === 0)) layers.push(style.conditional.get(dataRow % 2 ? 'band2Horz' : 'band1Horz'));
        if (looks.firstColumn && place.column === 0) layers.push(style.conditional.get('firstCol'));
        if (looks.lastColumn && place.column + place.span >= columnCount) layers.push(style.conditional.get('lastCol'));
        if (looks.lastRow && rowIndex === rows.length - 1) layers.push(style.conditional.get('lastRow'));
        if (looks.firstRow && rowIndex === 0) layers.push(style.conditional.get('firstRow'));
        const conditional = layers.filter(Boolean);
        const cellProps = readProps(child(cell, 'tcPr'), mergeProps(style.tcPr, ...conditional.map(layer => layer.tcPr)));
        const td = html('td');
        if (place.span > 1) td.colSpan = Math.min(place.span, MAX_TABLE_COLUMNS);
        if (place.rowSpan > 1) td.rowSpan = place.rowSpan;
        const edge = (side) => {
          const own = cellProps.tcBorders?.[side] || cellProps.tcBorders?.[{ left: 'start', right: 'end' }[side]];
          if (own) return borderCss(own);
          const outer = side === 'top' ? place.row === 0 : side === 'bottom' ? place.row + place.rowSpan >= rows.length
            : side === 'left' ? place.column === 0 : place.column + place.span >= columnCount;
          const name = outer ? side : side === 'top' || side === 'bottom' ? 'insideH' : 'insideV';
          return borderCss(borders[name] || borders[{ left: 'start', right: 'end' }[name]]);
        };
        const cellMargin = (side, fallback) => {
          const value = cellProps.tcMar?.[side] || cellProps.tcMar?.[{ left: 'start', right: 'end' }[side]] || margins[side] || margins[{ left: 'start', right: 'end' }[side]];
          return twips(value?.w) ?? fallback;
        };
        applyCss(td, {
          'padding-top': pt(cellMargin('top', 0)), 'padding-bottom': pt(cellMargin('bottom', 0)),
          'padding-left': pt(cellMargin('left', 5.4)), 'padding-right': pt(cellMargin('right', 5.4)),
          ...Object.fromEntries(['top', 'bottom', 'left', 'right'].map(side => [`border-${side}`, edge(side)]).filter(([, value]) => value)),
          ...(shading(cellProps.shd) ? { 'background-color': shading(cellProps.shd) } : {}),
          ...({ center: { 'vertical-align': 'middle' }, bottom: { 'vertical-align': 'bottom' } }[cellProps.vAlign?.val] || {}),
        });
        const saved = context.table;
        const savedPrevious = context.previous;
        context.table = { pPr: mergeProps(style.pPr, ...conditional.map(layer => layer.pPr)), rPr: mergeProps(style.rPr, ...conditional.map(layer => layer.rPr)) };
        context.previous = null;
        convertBlocks(cell, td);
        context.table = saved;
        context.previous = savedPrevious;
        element.append(td);
      }
      context.tableElements += element.getElementsByTagName('*').length + 1;
      if (context.tableElements > MAX_TABLE_ELEMENTS) throw Object.assign(new Error('DOCX tables exceed the 200,000 element limit.'), { code: 'PAGE_LIMIT' });
      return element;
    };
    // Header rows are converted with the table, before its body rows, so their notes and numbers stay in order.
    let headerTemplate = null;
    if (header.length) {
      headerTemplate = html('thead');
      for (const row of header) headerTemplate.append(convertRow(row));
    }
    const create = () => {
      const element = applyCss(html('table'), tableCss);
      if (grid.length) {
        const group = html('colgroup');
        for (const value of grid) group.append(value ? applyCss(html('col'), { width: pt(value) }) : html('col'));
        element.append(group);
      }
      if (headerTemplate) element.append(cloneMapped(headerTemplate, sourceOf));
      const target = html('tbody');
      element.append(target);
      return { element, target };
    };
    return { rows: rows.slice(header.length), create, convertRow, props };
  };
  const convertTable = (table) => {
    const model = tableModel(table);
    const { element, target } = model.create();
    for (const row of model.rows) target.append(model.convertRow(row));
    return element;
  };
  const convertBlocks = (parent, target) => {
    for (const item of elements(parent)) {
      const name = item.localName;
      if (name === 'p') target.append(paragraph(item));
      else if (name === 'tbl') { context.previous = null; target.append(convertTable(item)); }
      else if (name === 'sdt') convertBlocks(child(item, 'sdtContent'), target);
      else if (name === 'customXml') convertBlocks(item, target);
      else if (name === 'altChunk') { limitations.add('unsupported-embedded-object', 'object'); target.append(placeholder('[Embedded document not shown]')); }
    }
  };

  // A saved page break before any content starts the block on a new page; one
  // after content means the block continues onto the next page.
  const breakPosition = (node, isMarker) => {
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    let content = false;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (isMarker(current)) return content ? 'inside' : 'before';
      if (current.localName === 't' ? current.textContent.length > 0 : ['tab', 'drawing', 'pict', 'object', 'sym', 'oMath'].includes(current.localName)) content = true;
    }
    return null;
  };
  const softMarker = (node) => node.localName === 'lastRenderedPageBreak';
  const hardMarker = (node) => node.localName === 'br' && val(node, 'type') === 'page';

  // Sections: each w:sectPr closes a section; the body's last one closes the final section.
  const blocks = [];
  const flatten = (node) => {
    for (const item of elements(node)) {
      if (['p', 'tbl', 'altChunk'].includes(item.localName)) blocks.push(item);
      else if (item.localName === 'sdt') flatten(child(item, 'sdtContent'));
      else if (item.localName === 'customXml') flatten(item);
    }
  };
  flatten(body);
  const splitAtPageBreak = (paragraph) => {
    const pageBreak = [...paragraph.getElementsByTagNameNS('*', 'br')].find(item => val(item, 'type') === 'page');
    const breakRun = pageBreak?.parentNode;
    if (!breakRun || breakRun.localName !== 'r' || breakRun.parentNode !== paragraph) return null;
    const second = paragraph.cloneNode(false);
    const properties = child(paragraph, 'pPr');
    const copy = properties ? properties.cloneNode(true) : paragraph.ownerDocument.createElementNS(paragraph.namespaceURI, paragraph.prefix ? `${paragraph.prefix}:pPr` : 'pPr');
    // The continuation is not a new list item, and the section (if any) ends after it.
    for (const item of elements(copy)) if (['numPr', 'pageBreakBefore'].includes(item.localName)) item.remove();
    child(properties, 'sectPr')?.remove();
    copy.append(paragraph.ownerDocument.createElementNS(paragraph.namespaceURI, paragraph.prefix ? `${paragraph.prefix}:pageBreakBefore` : 'pageBreakBefore'));
    second.append(copy);
    const rest = breakRun.cloneNode(false);
    if (child(breakRun, 'rPr')) rest.append(child(breakRun, 'rPr').cloneNode(true));
    while (pageBreak.nextSibling) rest.append(pageBreak.nextSibling);
    pageBreak.remove();
    if (elements(rest).some(item => item.localName !== 'rPr')) second.append(rest);
    while (breakRun.nextSibling) second.append(breakRun.nextSibling);
    paragraph.after(second);
    return second;
  };
  const remainders = new Set();
  for (let index = 0; index < blocks.length; index++) {
    if (blocks[index].localName !== 'p' || breakPosition(blocks[index], hardMarker) !== 'inside') continue;
    const second = splitAtPageBreak(blocks[index]);
    if (second) { blocks.splice(index + 1, 0, second); remainders.add(second); }
  }
  const sections = [];
  const blockSection = blocks.map((block) => {
    const index = sections.length;
    const sectionProperties = block.localName === 'p' ? child(child(block, 'pPr'), 'sectPr') : null;
    if (sectionProperties) sections.push(sectionProperties);
    return index;
  });
  sections.push(child(body, 'sectPr'));
  const sectionType = (index) => val(child(sections[index], 'type')) || 'nextPage';
  const titlePage = (index) => isOn(child(sections[index], 'titlePg') && { val: val(child(sections[index], 'titlePg')) ?? '1' });
  const pageStyles = new Map();
  const pageStyle = (name) => {
    if (!pageStyles.has(name)) {
      const [, index, first] = name.match(/^s(\d+)(:first)?$/) || [];
      pageStyles.set(name, index === undefined ? null : { name, index: Number(index), first: !!first });
    }
    return pageStyles.get(name);
  };
  const firstPageStyle = (index) => `s${index}${titlePage(index) ? ':first' : ''}`;
  const geometry = (index) => {
    const size = child(sections[index], 'pgSz');
    const margin = child(sections[index], 'pgMar');
    const number = (node, name, fallback) => Number.isFinite(Number(val(node, name))) && val(node, name) !== null ? Math.abs(Number(val(node, name))) / 20 : fallback;
    return {
      width: number(size, 'w', 595.3), height: number(size, 'h', 841.9),
      top: number(margin, 'top', 72), right: number(margin, 'right', 72), bottom: number(margin, 'bottom', 72), left: number(margin, 'left', 72),
      header: number(margin, 'header', 35.4), footer: number(margin, 'footer', 35.4),
    };
  };
  // A section without its own header or footer inherits the previous section's.
  const partReference = (index, kind, type) => {
    for (let current = index; current >= 0; current--) {
      const reference = elements(sections[current]).find(item => item.localName === `${kind}Reference` && (val(item, 'type') || 'default') === type);
      if (reference) return rels('word/document.xml').get(val(reference, 'id'))?.path || null;
    }
    return null;
  };
  const partTemplates = new Map();
  const partTemplate = (path, contentWidth) => {
    const key = `${path}|${contentWidth}`;
    if (!partTemplates.has(key)) {
      const doc = parse(path);
      let element = null;
      if (doc) {
        const saved = { part: context.part, notes: context.notes, previous: context.previous, contentWidth: context.contentWidth, fields: context.fields };
        Object.assign(context, { part: path, notes: null, previous: null, contentWidth, fields: [] });
        element = html('div');
        convertBlocks(doc.documentElement, element);
        Object.assign(context, saved);
      }
      partTemplates.set(key, { element, source: doc?.documentElement || null });
    }
    return partTemplates.get(key);
  };
  const settings = parse('word/settings.xml');
  const defaultTab = twips(val(descendant(settings, 'defaultTabStop'))) || 36;
  // Word 2013 and later (compatibility mode 15) move the paragraph mark after a page break to the next page.
  const compatibilityMode = Number(val([...(settings?.getElementsByTagNameNS('*', 'compatSetting') || [])]
    .find(setting => val(setting, 'name') === 'compatibilityMode'))) || 12;
  // Word shows a page colour (w:background) in print layout.
  const pageColor = val(child(document_.documentElement, 'background'), 'color');
  const createPage = (style) => {
    const page = geometry(style.index);
    const root = applyCss(html('div', 'doc-page'), {
      width: pt(page.width), height: pt(page.height), ...(HEX.test(pageColor || '') ? { 'background-color': `#${pageColor}` } : {}),
      'padding-top': pt(page.top), 'padding-right': pt(page.right), 'padding-bottom': pt(page.bottom), 'padding-left': pt(page.left),
      'tab-size': pt(defaultTab), 'font-family': "'Times New Roman', serif", 'font-size': '10pt', 'line-height': 'normal',
    });
    const result = { root, body: html('div', 'doc-body'), notes: html('div', 'doc-notes') };
    root.append(result.body, result.notes);
    const contentWidth = page.width - page.left - page.right;
    for (const kind of ['header', 'footer']) {
      const path = style.first ? partReference(style.index, kind, 'first') : partReference(style.index, kind, 'default');
      const template = path ? partTemplate(path, contentWidth) : null;
      if (!template?.element) continue;
      const element = applyCss(template.element.cloneNode(true), {
        position: 'absolute', left: pt(page.left), right: pt(page.right), ...(kind === 'header' ? { top: pt(page.header) } : { bottom: pt(page.footer) }),
      });
      element.className = `doc-${kind}`;
      root.append(element);
      result[kind] = element;
      result[`${kind}Source`] = template.source;
    }
    // Word moves the body down (or up) when a header (or footer) is taller than its margin.
    result.afterAttach = () => {
      const scale = 96 / 72;
      if (result.header) {
        const bottom = result.header.offsetTop + result.header.offsetHeight;
        if (bottom > page.top * scale) root.style.paddingTop = `${bottom}px`;
      }
      if (result.footer) {
        const top = root.offsetHeight - result.footer.offsetTop;
        if (top > page.bottom * scale) root.style.paddingBottom = `${top}px`;
      }
    };
    return result;
  };

  const useSoftBreaks = body.getElementsByTagNameNS('*', 'lastRenderedPageBreak').length > 0;
  // Sections with several columns (w:cols w:num > 1) draw their paragraphs in CSS
  // columns; a page holds one column box per section, balanced like a continuous section.
  const columnGroups = new Map();
  const columnsOf = (index) => {
    if (!columnGroups.has(index)) {
      const columns = child(sections[index], 'cols');
      const count = Math.min(10, Math.floor(Number(val(columns, 'num')) || 1));
      const explicit = elements(columns).filter(item => item.localName === 'col');
      const total = count > 1 ? count : explicit.length > 1 && !isOn({ val: val(columns, 'equalWidth') ?? '1' }) ? Math.min(10, explicit.length) : 1;
      const gap = Math.max(0, Math.min(144, twips(val(columns, 'space')) ?? twips(val(explicit[0], 'space')) ?? 36));
      const css = { 'column-count': String(total), 'column-gap': pt(gap), ...(isOn({ val: val(columns, 'sep') ?? '0' }) ? { 'column-rule': '0.75pt solid #000000' } : {}) };
      columnGroups.set(index, total > 1 ? { create: () => { const element = applyCss(html('div', 'doc-columns'), css); return { element, target: element }; } } : null);
    }
    return columnGroups.get(index);
  };
  const carried = {};
  const pieces = [];
  context.notes = [];
  blocks.forEach((block, index) => {
    signal?.throwIfAborted();
    const section = blockSection[index];
    const sectionStart = index > 0 && section !== blockSection[index - 1];
    const sectionBreak = !sectionStart ? {} : sectionType(section) === 'continuous' ? { styleChange: `s${section}` } : { master: firstPageStyle(section) };
    const breaksOf = (node) => {
      const soft = breakPosition(node, softMarker);
      const hard = breakPosition(node, hardMarker);
      return { softBefore: soft === 'before', softAfter: soft === 'inside', ...(hard === 'before' ? { before: true } : hard === 'inside' ? { after: true } : {}) };
    };
    if (block.localName === 'tbl') {
      context.previous = null;
      const model = tableModel(block);
      // A table made only of header rows is still drawn.
      if (!model.rows.length) {
        pieces.push({ element: model.create().element, notes: context.notes, source: block, ...carried, ...breaksOf(block), ...sectionBreak });
        for (const key of Object.keys(carried)) delete carried[key];
        context.notes = [];
        return;
      }
      model.rows.forEach((row, rowIndex) => {
        const element = model.convertRow(row);
        pieces.push({ element, group: model, notes: context.notes, source: row, ...(rowIndex ? {} : carried), ...breaksOf(row), ...(rowIndex ? {} : sectionBreak) });
        if (!rowIndex) for (const key of Object.keys(carried)) delete carried[key];
        context.notes = [];
      });
      return;
    }
    const page = geometry(section);
    context.contentWidth = page.width - page.left - page.right;
    context.pageLeft = page.left;
    const properties = block.localName === 'p' ? readProps(child(block, 'pPr'), mergeProps(defaults.pPr, styleChain(val(child(child(block, 'pPr'), 'pStyle')) || defaultStyles.paragraph).pPr)) : {};
    const breaks = { ...breaksOf(block), ...(isOn(properties.pageBreakBefore) ? { before: true } : {}), ...sectionBreak };
    // As in Word, an empty paragraph that closes a section keeps its line, and so does the empty rest
    // of a paragraph after its page break from compatibility mode 15; before that the rest takes no
    // line and its breaks move to the next block.
    if (block.localName === 'p' && remainders.has(block) && compatibilityMode < 15 && !hasVisibleContent(block) && !breaks.after && !breaks.softBefore && !breaks.softAfter) {
      Object.assign(carried, Object.fromEntries(Object.entries(breaks).filter(([, value]) => value)));
      return;
    }
    const element = block.localName === 'p' ? paragraph(block) : (() => { const holder = html('div'); convertBlocks({ childNodes: [block] }, holder); return holder; })();
    // Without w:widowControl Word and LibreOffice split a paragraph after any line; w:keepLines keeps it whole.
    const lines = isOn(properties.keepLines) ? { orphans: 1000 } : isOn(properties.widowControl) ? {} : { orphans: 1, widows: 1 };
    pieces.push({ element, notes: context.notes, source: block, trimTop: true, ...lines, ...(columnsOf(section) ? { group: columnsOf(section) } : {}), ...carried, ...breaks });
    for (const key of Object.keys(carried)) delete carried[key];
    context.notes = [];
  });
  // Endnotes follow the body, after a separator.
  if (context.endnotes.length) {
    const separator = applyCss(html('div'), { width: '33%', 'border-top': '0.5pt solid #000000', margin: '6pt 0' });
    pieces.push({ element: separator, notes: [], source: document_.createElement('separator') });
    for (const endnote of context.endnotes) pieces.push({ element: endnote.element, notes: [], source: endnote.source });
  }
  const pages = await paginateAndRender({
    pieces, useSoftBreaks, label: 'DOCX', signal, encodePageImage, maxImageCharacters, pendingImages, sourceOf, pageImages, redact,
    firstStyle: pageStyle(firstPageStyle(0)),
    styleByName: pageStyle,
    nextStyle: (style) => style.first ? pageStyle(`s${style.index}`) : style,
    createPage,
  });
  return { pages, imageLimitations: limitations.list(), invisibleSources: pages.invisibleSources, listLabels };
};
