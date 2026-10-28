// Converts an OpenDocument text into pieces for the shared page engine.
// Pages follow the soft page breaks Writer stores when it saves; without them
// the document is paginated by measuring the layout.
import {
  BORDER, FONT_FAMILY, PERCENT, applyCss, cloneMapped, createImageSources, createLimitations, formatNumber,
  html, imageLoaded, isColor, isLength, isLengthOrPercent, mappedText, paginateAndRender, placeholder, toPx,
} from './pageLayout.js';

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  math: 'http://www.w3.org/1998/Math/MathML',
};
const PREFIX = new Map(Object.entries(NS).map(([prefix, uri]) => [uri, prefix]));

const MAX_TABLE_COLUMNS = 256;
const MAX_REPEATED_ROWS = 100;
// Repeated cells and rows multiply through nested tables; a document under 1 KB
// could otherwise build millions of elements before pagination can stop it.
const MAX_TABLE_ELEMENTS = 200_000;
const MAX_RENDERED_SPACES = 1000;

const is = (node, ns, ...names) => node?.nodeType === Node.ELEMENT_NODE && node.namespaceURI === NS[ns] && names.includes(node.localName);
const attr = (node, ns, name) => node?.getAttributeNS(NS[ns], name) ?? null;
const childElements = (node) => node ? [...node.childNodes].filter(child => child.nodeType === Node.ELEMENT_NODE) : [];
const firstChild = (node, ns, name) => childElements(node).find(child => is(child, ns, name)) || null;
// Attributes keyed as "prefix:name" with canonical prefixes, whatever the file declares.
const attributesOf = (node) => {
  const result = {};
  for (const attribute of node?.attributes || []) {
    const prefix = PREFIX.get(attribute.namespaceURI);
    if (prefix) result[`${prefix}:${attribute.localName}`] = attribute.value;
  }
  return result;
};

const GENERIC_FONTS = { roman: 'serif', swiss: 'sans-serif', modern: 'monospace', script: 'cursive', decorative: 'fantasy' };

const boxCss = (properties, css) => {
  for (const side of ['', '-top', '-bottom', '-left', '-right']) {
    if (isLengthOrPercent(properties[`fo:margin${side}`])) css[`margin${side}`] = properties[`fo:margin${side}`];
    if (isLength(properties[`fo:padding${side}`])) css[`padding${side}`] = properties[`fo:padding${side}`];
    if (BORDER.test(properties[`fo:border${side}`] || '')) css[`border${side}`] = properties[`fo:border${side}`];
  }
  if (isColor(properties['fo:background-color'])) css['background-color'] = properties['fo:background-color'];
  return css;
};
const textCss = (properties = {}, fonts) => {
  const css = {};
  if (isLengthOrPercent(properties['fo:font-size'])) css['font-size'] = properties['fo:font-size'];
  if (/^(?:bold|normal|[1-9]00)$/.test(properties['fo:font-weight'] || '')) css['font-weight'] = properties['fo:font-weight'];
  if (/^(?:italic|normal|oblique)$/.test(properties['fo:font-style'] || '')) css['font-style'] = properties['fo:font-style'];
  if (/^(?:small-caps|normal)$/.test(properties['fo:font-variant'] || '')) css['font-variant'] = properties['fo:font-variant'];
  if (/^(?:none|uppercase|lowercase|capitalize)$/.test(properties['fo:text-transform'] || '')) css['text-transform'] = properties['fo:text-transform'];
  if (isLength(properties['fo:letter-spacing'])) css['letter-spacing'] = properties['fo:letter-spacing'];
  const lines = [];
  if (properties['style:text-underline-style'] && properties['style:text-underline-style'] !== 'none') lines.push('underline');
  if (properties['style:text-line-through-style'] && properties['style:text-line-through-style'] !== 'none') lines.push('line-through');
  if (lines.length) css['text-decoration-line'] = lines.join(' ');
  if (isColor(properties['fo:color'])) css.color = properties['fo:color'];
  if (isColor(properties['fo:background-color'])) css['background-color'] = properties['fo:background-color'];
  const family = fonts.get(properties['style:font-name']) ||
    (FONT_FAMILY.test(properties['fo:font-family'] || '') ? `${properties['fo:font-family']}, ${GENERIC_FONTS[properties['style:font-family-generic']] || 'serif'}` : '');
  if (family) css['font-family'] = family;
  const [position, size] = (properties['style:text-position'] || '').trim().split(/\s+/);
  const raised = position === 'super' || /^\d/.test(position || '') && parseFloat(position) > 0;
  const lowered = position === 'sub' || /^-\d/.test(position || '');
  if (raised || lowered) {
    css['vertical-align'] = raised ? 'super' : 'sub';
    css['font-size'] = PERCENT.test(size || '') ? size : '58%';
  }
  if (properties['text:display'] === 'none') css.display = 'none';
  return css;
};
const ALIGN = { start: 'left', left: 'left', end: 'right', right: 'right', center: 'center', justify: 'justify' };
const paragraphCss = (properties = {}) => {
  const css = boxCss(properties, {});
  // Writer adds the spacing below a paragraph to the spacing above the next instead of
  // collapsing them, so without a border or background the spacing becomes padding.
  if (!css['background-color'] && !Object.keys(css).some(key => key.startsWith('border'))) {
    for (const side of ['top', 'bottom']) {
      const margin = css[`margin-${side}`];
      if (!margin) continue;
      const padding = css[`padding-${side}`] || css.padding;
      css[`padding-${side}`] = padding ? `calc(${margin} + ${padding.split(/\s+/)[0]})` : margin;
      delete css[`margin-${side}`];
    }
  }
  if (ALIGN[properties['fo:text-align']]) css['text-align'] = ALIGN[properties['fo:text-align']];
  if (isLength(properties['fo:text-indent'])) css['text-indent'] = properties['fo:text-indent'];
  // Writer's proportional spacing is relative to the font's own line height (about 1.15 em), not to its size.
  if (PERCENT.test(properties['fo:line-height'] || '')) css['line-height'] = String(Math.round(parseFloat(properties['fo:line-height']) * 1.15 * 10) / 1000);
  else if (isLength(properties['fo:line-height']) || properties['fo:line-height'] === 'normal') css['line-height'] = properties['fo:line-height'];
  return css;
};
const cellCss = (properties = {}) => {
  const css = boxCss(properties, {});
  if (/^(?:top|middle|bottom)$/.test(properties['style:vertical-align'] || '')) css['vertical-align'] = properties['style:vertical-align'];
  return css;
};
// Styles: content automatic styles, then styles.xml automatic styles (headers
// and footers), then common styles, each following its parent chain.
const createStyleSheet = (content, styles) => {
  const fonts = new Map();
  const common = new Map();
  const automatic = { content: new Map(), styles: new Map() };
  const lists = { content: new Map(), styles: new Map(), common: new Map() };
  const defaults = new Map();
  const pageLayouts = new Map();
  const masters = new Map();
  let firstMaster = null;
  let outline = null;
  const sections = (doc, name) => doc ? [...doc.documentElement?.childNodes || []].filter(node => is(node, 'office', name)) : [];
  for (const doc of [styles, content]) {
    for (const decls of sections(doc, 'font-face-decls')) for (const face of childElements(decls)) {
      const family = attr(face, 'svg', 'font-family');
      if (is(face, 'style', 'font-face') && FONT_FAMILY.test(family || '')) {
        fonts.set(attr(face, 'style', 'name'), `${family}, ${GENERIC_FONTS[attr(face, 'style', 'font-family-generic')] || 'serif'}`);
      }
    }
  }
  const register = (node, target, listTarget) => {
    const family = attr(node, 'style', 'family');
    if (is(node, 'style', 'style')) target.set(`${family}:${attr(node, 'style', 'name')}`, node);
    else if (is(node, 'style', 'default-style')) defaults.set(family, node);
    else if (is(node, 'text', 'list-style')) listTarget.set(attr(node, 'style', 'name'), node);
    else if (is(node, 'text', 'outline-style')) outline = node;
    else if (is(node, 'style', 'page-layout')) pageLayouts.set(attr(node, 'style', 'name'), node);
  };
  for (const section of sections(styles, 'styles')) for (const node of childElements(section)) register(node, common, lists.common);
  for (const section of sections(styles, 'automatic-styles')) for (const node of childElements(section)) register(node, automatic.styles, lists.styles);
  for (const section of sections(content, 'automatic-styles')) for (const node of childElements(section)) register(node, automatic.content, lists.content);
  for (const section of sections(styles, 'master-styles')) for (const node of childElements(section)) {
    if (!is(node, 'style', 'master-page')) continue;
    masters.set(attr(node, 'style', 'name'), node);
    firstMaster ||= node;
  }
  const readProperties = (node) => ({
    paragraph: attributesOf(firstChild(node, 'style', 'paragraph-properties')),
    text: attributesOf(firstChild(node, 'style', 'text-properties')),
    table: attributesOf(firstChild(node, 'style', 'table-properties')),
    row: attributesOf(firstChild(node, 'style', 'table-row-properties')),
    cell: attributesOf(firstChild(node, 'style', 'table-cell-properties')),
    column: attributesOf(firstChild(node, 'style', 'table-column-properties')),
    graphic: attributesOf(firstChild(node, 'style', 'graphic-properties')),
  });
  // A style's style:tab-stops replaces its parent's list: { position (px from the paragraph indent), type }.
  const tabStops = (node) => {
    const list = firstChild(firstChild(node, 'style', 'paragraph-properties'), 'style', 'tab-stops');
    if (!list) return null;
    return childElements(list).filter(stop => is(stop, 'style', 'tab-stop') && isLength(attr(stop, 'style', 'position')))
      .map(stop => ({ position: Math.max(0, Math.min(5000, toPx(attr(stop, 'style', 'position')))), type: ['center', 'right', 'char'].includes(attr(stop, 'style', 'type')) ? attr(stop, 'style', 'type') : 'left' }))
      .sort((first, second) => first.position - second.position).slice(0, 64);
  };
  const merge = (base, own) => Object.fromEntries(Object.keys(own).map(group => [group, { ...base[group], ...own[group] }]));
  const cache = new Map();
  const find = (scope, family, name) => name ? automatic[scope].get(`${family}:${name}`) || common.get(`${family}:${name}`) || null : null;
  const resolveChain = (scope, family, name, depth = 0) => {
    const key = `${scope}|${family}|${name}`;
    if (cache.has(key)) return cache.get(key);
    const base = defaults.has(family) ? readProperties(defaults.get(family)) : readProperties(null);
    const node = find(scope, family, name);
    let resolved;
    const baseStops = defaults.has(family) ? tabStops(defaults.get(family)) : null;
    if (!node || depth > 20) resolved = { ...base, listStyleName: null, outlineLevel: null, tabStops: baseStops || [] };
    else {
      const parentName = attr(node, 'style', 'parent-style-name');
      const parent = parentName ? resolveChain(scope, family, parentName, depth + 1) : { ...base, listStyleName: null, outlineLevel: null, tabStops: baseStops || [] };
      resolved = {
        ...merge(parent, readProperties(node)),
        listStyleName: attr(node, 'style', 'list-style-name') || parent.listStyleName,
        outlineLevel: Number(attr(node, 'style', 'default-outline-level')) || parent.outlineLevel,
        tabStops: tabStops(node) || parent.tabStops,
      };
    }
    cache.set(key, resolved);
    return resolved;
  };
  // A page style starts a new page; it is not inherited by child styles.
  const resolve = (scope, family, name) => ({ ...resolveChain(scope, family, name), masterPageName: attr(find(scope, family, name), 'style', 'master-page-name') || null });
  const listStyle = (scope, name) => name ? lists[scope].get(name) || lists.common.get(name) || null : null;
  // Columns of a text:section style (style:columns fo:column-count, fo:column-gap, style:column-sep).
  const sectionColumns = (name) => {
    const columns = firstChild(firstChild(find('content', 'section', name), 'style', 'section-properties'), 'style', 'columns');
    const count = Math.min(10, Math.floor(Number(attr(columns, 'fo', 'column-count')) || 1));
    if (count < 2) return null;
    const separator = firstChild(columns, 'style', 'column-sep');
    const gap = attr(columns, 'fo', 'column-gap');
    return {
      'column-count': String(count), 'column-gap': isLength(gap) ? `${Math.round(Math.min(500, Math.max(0, toPx(gap))) * 100) / 100}px` : '0.5cm',
      ...(separator && attr(separator, 'style', 'style') !== 'none' ? { 'column-rule': `1px solid ${isColor(attr(separator, 'style', 'color')) ? attr(separator, 'style', 'color') : '#000000'}` } : {}),
    };
  };
  const tabSize = attributesOf(firstChild(defaults.get('paragraph'), 'style', 'paragraph-properties'))['style:tab-stop-distance'];
  return {
    fonts, resolve, listStyle, sectionColumns, outline, masters, pageLayouts,
    defaultMaster: masters.get('Standard') || masters.get('Default') || firstMaster,
    tabSize: isLength(tabSize) ? tabSize : '1.25cm',
  };
};

const pageGeometry = (styleSheet, master) => {
  const layout = styleSheet.pageLayouts.get(attr(master, 'style', 'page-layout-name'));
  const page = attributesOf(firstChild(layout, 'style', 'page-layout-properties'));
  const headerFooter = (name) => attributesOf(firstChild(firstChild(layout, 'style', name), 'style', 'header-footer-properties'));
  const margin = (side) => isLength(page[`fo:margin-${side}`]) ? page[`fo:margin-${side}`] : isLength(page['fo:margin']) ? page['fo:margin'] : '2cm';
  return {
    width: isLength(page['fo:page-width']) ? page['fo:page-width'] : '21cm',
    height: isLength(page['fo:page-height']) ? page['fo:page-height'] : '29.7cm',
    margins: { top: margin('top'), right: margin('right'), bottom: margin('bottom'), left: margin('left') },
    background: isColor(page['fo:background-color']) ? page['fo:background-color'] : null,
    header: headerFooter('header-style'),
    footer: headerFooter('footer-style'),
  };
};

export const renderOdtPages = async ({ content, styles, entries, signal, encodePageImage, sniffFormat, bitmapDimensions, bytesToBase64, maxImageCharacters, maxPixels, pageImages, redact }) => {
  const styleSheet = createStyleSheet(content, styles);
  const limitations = createLimitations();
  // Drawn text nodes -> their XML text nodes; list and heading paragraphs -> their drawn number or bullet.
  const sourceOf = new WeakMap();
  const listLabels = new Map();
  const limit = limitations.add;

  const partName = (href) => (href || '').replace(/^\.\//, '').replace(/\/$/, '');
  const imageSource = createImageSources({ entries, sniffFormat, bitmapDimensions, bytesToBase64, maxPixels });
  const pendingImages = [];
  const objectCache = new Map();
  const embeddedObject = (name) => {
    if (objectCache.has(name)) return objectCache.get(name);
    let result = { kind: 'object' };
    const data = entries[`${name}/content.xml`];
    if (data) {
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(data), 'application/xml');
      const root = doc.documentElement;
      if (!doc.querySelector('parsererror') && root?.namespaceURI === NS.math && root.localName === 'math') result = { kind: 'formula', math: root };
      else if (doc.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:chart:1.0', 'chart').length) result = { kind: 'chart' };
    }
    objectCache.set(name, result);
    return result;
  };
  const MATH_ATTRIBUTES = ['mathvariant', 'display', 'stretchy', 'fence', 'separator', 'lspace', 'rspace', 'accent', 'accentunder', 'movablelimits', 'largeop', 'symmetric', 'minsize', 'maxsize', 'linethickness', 'displaystyle', 'scriptlevel', 'columnalign', 'rowalign', 'columnspan', 'rowspan', 'form', 'mathsize', 'notation'];
  const importMath = (node, depth = 0) => {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) return document.createTextNode(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE || node.namespaceURI !== NS.math || depth > 200) return null;
    if (['annotation', 'annotation-xml'].includes(node.localName)) return null;
    const element = document.createElementNS(NS.math, node.localName);
    for (const name of MATH_ATTRIBUTES) {
      const value = node.getAttribute(name);
      if (value !== null && /^[\w .%#-]{0,40}$/.test(value)) element.setAttribute(name, value);
    }
    for (const child of node.childNodes) {
      const imported = importMath(child, depth + 1);
      if (imported) element.append(imported);
    }
    return element;
  };

  // Conversion state. Notes are collected per pagination piece; fields are filled per page.
  const context = { scope: 'content', notes: null, counters: new Map(), endnotes: [], tableElements: 0 };
  const countTableElements = (count) => {
    context.tableElements += count;
    if (context.tableElements > MAX_TABLE_ELEMENTS) throw Object.assign(new Error('ODT tables exceed the 200,000 element limit.'), { code: 'PAGE_LIMIT' });
  };
  const elementCount = (element) => element.getElementsByTagName('*').length + 1;
  const SKIPPED = new Set(['sequence-decls', 'variable-decls', 'user-field-decls', 'dde-connection-decls', 'tracked-changes', 'soft-page-break',
    'bookmark', 'bookmark-start', 'bookmark-end', 'reference-mark', 'reference-mark-start', 'reference-mark-end', 'toc-mark', 'toc-mark-start', 'toc-mark-end',
    'alphabetical-index-mark', 'alphabetical-index-mark-start', 'alphabetical-index-mark-end', 'user-index-mark', 'user-index-mark-start', 'user-index-mark-end',
    'change', 'change-start', 'change-end', 'index-title-template']);
  const isSkipped = (node) => node.namespaceURI === NS.text && (SKIPPED.has(node.localName) || node.localName.endsWith('-source')) ||
    is(node, 'office', 'annotation', 'annotation-end', 'forms', 'event-listeners') || is(node, 'svg', 'title', 'desc') || is(node, 'table', 'named-expressions');
  const collapse = (value) => value.replace(/[\t\n\r ]+/g, ' ');

  const appendInline = (parent, node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) parent.append(mappedText(collapse(child.textContent), child, sourceOf));
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const converted = convertInline(child);
        if (converted) parent.append(converted);
      }
    }
    return parent;
  };
  const convertInline = (node) => {
    if (isSkipped(node)) return null;
    if (is(node, 'text', 'span') || is(node, 'text', 'a')) {
      return appendInline(applyCss(html('span'), textCss(styleSheet.resolve(context.scope, 'text', attr(node, 'text', 'style-name')).text, styleSheet.fonts)), node);
    }
    if (is(node, 'text', 's')) {
      const count = Number(attr(node, 'text', 'c') ?? 1);
      return document.createTextNode(' '.repeat(Number.isSafeInteger(count) && count > 0 ? Math.min(count, MAX_RENDERED_SPACES) : 1));
    }
    if (is(node, 'text', 'tab')) return document.createTextNode('\t');
    if (is(node, 'text', 'line-break')) return html('br');
    if (is(node, 'text', 'note')) return note(node);
    if (is(node, 'text', 'page-number', 'page-count')) {
      const field = appendInline(html('span'), node);
      field.dataset.pageField = node.localName;
      return field;
    }
    if (is(node, 'draw', 'frame')) return frame(node);
    if (node.namespaceURI === NS.draw && SHAPES.has(node.localName)) return shape(node);
    if (is(node, 'text', 'p', 'h', 'list', 'section') || is(node, 'table', 'table')) return convertBlock(node);
    return appendInline(html('span'), node);
  };
  const note = (node) => {
    const citation = firstChild(node, 'text', 'note-citation');
    const label = attr(citation, 'text', 'label') || citation?.textContent.trim() || '*';
    const mark = html('sup');
    mark.textContent = label;
    const endnote = attr(node, 'text', 'note-class') === 'endnote';
    if (context.notes || endnote && context.scope === 'content') {
      const body = html('div', 'doc-note');
      for (const child of childElements(firstChild(node, 'text', 'note-body'))) {
        const block = convertBlock(child);
        if (block) body.append(block);
      }
      const prefix = html('span');
      prefix.textContent = `${label} `;
      (body.querySelector('p') || body).prepend(prefix);
      if (endnote) context.endnotes.push({ element: body, source: node }); else context.notes.push(body);
    }
    return mark;
  };
  const SHAPES = new Set(['custom-shape', 'rect', 'ellipse', 'circle', 'polygon', 'polyline', 'path', 'line', 'connector', 'caption', 'regular-polygon', 'measure', 'g']);
  const shape = (node) => {
    const paragraphs = childElements(node).filter(child => is(child, 'text', 'p', 'h', 'list'));
    if (!paragraphs.length) {
      if (!is(node, 'draw', 'g')) limit('unsupported-embedded-object', 'drawing');
      else for (const child of childElements(node)) if (child.namespaceURI === NS.draw && SHAPES.has(child.localName)) shape(child);
      return null;
    }
    const box = applyCss(html('span'), { display: 'inline-block', border: '1px solid #000', padding: '2px 4px', 'vertical-align': 'middle' });
    for (const paragraph of paragraphs) box.append(convertBlock(paragraph));
    return box;
  };
  // Frames anchored to a paragraph or character: parallel, left, right and dynamic
  // wrapping float on the frame's side (text flows beside it), no wrapping is a block,
  // run-through is placed over (or behind) its paragraph. Margins come from fo:margin-*.
  const placeFrame = (box, node, graphic) => {
    const wrap = graphic['style:wrap'] || 'none';
    const position = graphic['style:horizontal-pos'] || 'center';
    const x = isLength(attr(node, 'svg', 'x')) ? Math.max(-2000, Math.min(2000, toPx(attr(node, 'svg', 'x')))) : 0;
    const y = isLength(attr(node, 'svg', 'y')) && ['from-top', undefined].includes(graphic['style:vertical-pos']) ? Math.max(-2000, Math.min(2000, toPx(attr(node, 'svg', 'y')))) : 0;
    const margin = (side) => isLength(graphic[`fo:margin-${side}`]) ? Math.max(0, Math.min(2000, toPx(graphic[`fo:margin-${side}`]))) : 0;
    const px = (value) => `${Math.round(value * 100) / 100}px`;
    if (['parallel', 'dynamic', 'biggest', 'left', 'right'].includes(wrap) && (position !== 'center' || ['left', 'right'].includes(wrap))) {
      const side = wrap === 'left' ? 'right' : wrap === 'right' ? 'left' : ['right', 'outside'].includes(position) ? 'right' : 'left';
      applyCss(box, {
        float: side, 'margin-top': px(margin('top') + Math.max(0, y)), 'margin-bottom': px(margin('bottom')),
        'margin-left': px(side === 'left' ? (position === 'from-left' ? Math.max(0, x) : 0) : margin('left')), 'margin-right': px(side === 'right' ? 0 : margin('right')),
      });
      box.dataset.anchored = 'float';
    } else if (wrap === 'run-through') {
      const left = position === 'from-left' ? { left: px(x) } : position === 'right' ? { right: '0' } : position === 'center' ? { left: '50%', transform: 'translateX(-50%)' } : { left: '0' };
      applyCss(box, { position: 'absolute', top: px(y), ...left, ...(graphic['style:run-through'] === 'background' ? { 'z-index': '-1' } : {}) });
      box.dataset.anchored = graphic['style:run-through'] === 'background' ? 'behind' : 'absolute';
    } else {
      applyCss(box, {
        'margin-top': px(margin('top') + Math.max(0, y)), 'margin-bottom': px(margin('bottom')),
        ...(position === 'center' ? { 'margin-left': 'auto', 'margin-right': 'auto' } : position === 'right' ? { 'margin-left': 'auto' } : position === 'from-left' && x > 0 ? { 'margin-left': px(x) } : {}),
      });
      box.dataset.anchored = 'block';
      // Writer lets an object that need not follow the text flow hang into the bottom margin.
      if (graphic['style:flow-with-text'] === 'false') box.dataset.overhang = 'true';
    }
  };
  const frame = (node) => {
    const width = isLength(attr(node, 'svg', 'width')) ? attr(node, 'svg', 'width') : null;
    const height = isLength(attr(node, 'svg', 'height')) ? attr(node, 'svg', 'height') : null;
    const graphic = styleSheet.resolve(context.scope, 'graphic', attr(node, 'draw', 'style-name')).graphic;
    const anchorType = attr(node, 'text', 'anchor-type');
    const asCharacter = anchorType === 'as-char';
    const box = applyCss(html('span'), {
      // A character-anchored frame at the top of the baseline (Writer's default) sits on the baseline.
      display: asCharacter ? 'inline-block' : 'block', 'vertical-align': asCharacter && ['middle', 'center'].includes(graphic['style:vertical-pos']) ? 'middle' : asCharacter && graphic['style:vertical-pos'] === 'bottom' ? 'top' : 'baseline', 'box-sizing': 'border-box',
      ...(width ? { width } : {}), 'max-width': '100%',
    });
    if (!asCharacter && anchorType !== 'page') placeFrame(box, node, graphic);
    applyCss(box, boxCss({ 'fo:border': graphic['fo:border'], 'fo:padding': graphic['fo:padding'], 'fo:background-color': graphic['fo:background-color'] }, {}));
    // Writer saves a frame's area fill as draw:fill-color and a drawn outline as svg:stroke-color.
    if (graphic['draw:fill'] === 'solid' && isColor(graphic['draw:fill-color'])) box.style.backgroundColor = graphic['draw:fill-color'];
    else if (graphic['draw:fill'] === 'none') box.style.removeProperty('background-color');
    if (['solid', 'dash'].includes(graphic['draw:stroke']) && isColor(graphic['svg:stroke-color']) && !box.style.borderTopStyle) {
      const stroke = `${Math.round(Math.min(20, Math.max(1, toPx(graphic['svg:stroke-width'], 1))) * 100) / 100}px ${graphic['draw:stroke'] === 'dash' ? 'dashed' : 'solid'} ${graphic['svg:stroke-color']}`;
      if (BORDER.test(stroke)) box.style.border = stroke;
    }
    const candidates = childElements(node).filter(child => !isSkipped(child));
    let failure = null;
    for (const child of candidates) {
      if (is(child, 'draw', 'text-box')) {
        // The box's own paragraphs set their alignment and spacing, not the paragraph it is anchored in.
        applyCss(box, { 'text-align': 'left', 'text-indent': '0', 'line-height': '1.15', ...(height && !asCharacter ? { 'min-height': height } : {}) });
        // A text frame without draw:stroke or fo:border keeps the default style's outline, as Writer draws it.
        if (!graphic['draw:stroke'] && !Object.keys(graphic).some(key => key.startsWith('fo:border')) && isColor(graphic['svg:stroke-color'])) box.style.border = `1px solid ${graphic['svg:stroke-color']}`;
        for (const block of childElements(child)) {
          const converted = convertBlock(block);
          if (converted) box.append(converted);
        }
        return box;
      }
      if (is(child, 'draw', 'image')) {
        const name = partName(attr(child, 'xlink', 'href'));
        // Images may also be stored inline as office:binary-data.
        const binary = firstChild(child, 'office', 'binary-data');
        let inlineData = null;
        if (binary && !name) {
          try {
            const decoded = atob(binary.textContent.replace(/\s+/g, ''));
            inlineData = new Uint8Array(decoded.length);
            for (let index = 0; index < decoded.length; index++) inlineData[index] = decoded.charCodeAt(index);
          } catch { inlineData = null; }
        }
        const source = imageSource(name, inlineData);
        if (source.src) {
          const image = html('img');
          image.src = source.src;
          pendingImages.push(imageLoaded(image));
          applyCss(image, { width: width ? '100%' : 'auto', ...(height && width ? { height } : {}), 'object-fit': 'contain' });
          box.append(image);
          return box;
        }
        failure ||= { reason: source.limitation, format: source.format, label: `[Image not shown: ${source.format.toUpperCase()}]` };
        continue;
      }
      if (is(child, 'draw', 'object', 'object-ole')) {
        const object = embeddedObject(partName(attr(child, 'xlink', 'href')));
        if (object.kind === 'formula') {
          const math = importMath(object.math);
          if (math) { box.append(math); applyCss(box, { width: 'auto' }); return box; }
        }
        failure ||= { reason: 'unsupported-embedded-object', format: object.kind, label: `[${object.kind === 'chart' ? 'Chart' : 'Embedded object'} not shown]` };
      }
    }
    if (!failure) return candidates.length ? box : null;
    limit(failure.reason, failure.format);
    box.append(placeholder(failure.label, width ? '100%' : null, height));
    return box;
  };

  const paragraph = (node) => {
    const resolved = styleSheet.resolve(context.scope, 'paragraph', attr(node, 'text', 'style-name'));
    const element = applyCss(html('p'), { ...paragraphCss(resolved.paragraph), ...textCss(resolved.text, styleSheet.fonts) });
    if (is(node, 'text', 'h')) {
      const level = Math.min(10, Math.max(1, Number(attr(node, 'text', 'outline-level')) || resolved.outlineLevel || 1));
      if (!resolved.text['fo:font-size']) element.style.fontSize = ['130%', '115%', '101%', '95%', '85%'][Math.min(level, 5) - 1];
      if (!resolved.text['fo:font-weight']) element.style.fontWeight = 'bold';
      if (attr(node, 'text', 'is-list-header') !== 'true') {
        const marker = levelMarker(styleSheet.outline, level, '\u0000outline', attr(node, 'text', 'restart-numbering') === 'true' ? 1 : null);
        if (marker) {
          element.append(`${marker} `);
          listLabels.set(node, marker);
        }
      }
    }
    // Centre, right and decimal tab stops: each tab directly in the paragraph starts a
    // segment placed at its stop (positions count from the paragraph's indent).
    const stops = resolved.tabStops.some(stop => stop.type !== 'left') ? resolved.tabStops : null;
    if (stops && childElements(node).some(child => is(child, 'text', 'tab'))) {
      applyCss(element, { position: 'relative' });
      element.append('​');
      let target = element;
      let index = 0;
      for (const child of node.childNodes) {
        if (is(child, 'text', 'tab') && index < stops.length) {
          const stop = stops[index++];
          target = applyCss(html('span'), {
            position: 'absolute', top: '0', left: `${Math.round(stop.position * 100) / 100}px`, 'white-space': 'pre',
            transform: stop.type === 'center' ? 'translateX(-50%)' : stop.type === 'left' ? 'none' : 'translateX(-100%)',
          });
          element.append(target);
        } else if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) target.append(mappedText(collapse(child.textContent), child, sourceOf));
        else if (child.nodeType === Node.ELEMENT_NODE) {
          const converted = convertInline(child);
          if (converted) target.append(converted);
        }
      }
    } else appendInline(element, node);
    // A paragraph holding only a frame with text above and below keeps its own (empty) line under it.
    if (element.querySelector('[data-anchored="block"]') && !element.textContent.replace(/​/g, '').trim()) element.append('​');
    // A frame placed over its paragraph is positioned against it, behind the text when it runs in the background.
    const placed = element.querySelector('[data-anchored="absolute"], [data-anchored="behind"]');
    if (placed) applyCss(element, { position: 'relative', ...(element.querySelector('[data-anchored="behind"]') ? { 'z-index': '0' } : {}) });
    return element;
  };
  const levelStyleOf = (listStyle, level) => childElements(listStyle).find(child => Number(attr(child, 'text', 'level')) === level) || null;
  // Numbers continue across a style's lists unless a list restarts them.
  const levelMarker = (listStyle, level, key, restartValue) => {
    const levelStyle = levelStyleOf(listStyle, level);
    if (!levelStyle) return '';
    if (is(levelStyle, 'text', 'list-level-style-bullet')) {
      const bullet = attr(levelStyle, 'text', 'bullet-char') || '•';
      return [...bullet][0] || '•';
    }
    if (is(levelStyle, 'text', 'list-level-style-image')) return '•';
    const counters = context.counters.get(key) || [];
    context.counters.set(key, counters);
    const startOf = (depth) => Number(attr(levelStyleOf(listStyle, depth), 'text', 'start-value')) || 1;
    counters[level] = restartValue ?? (counters[level] === undefined ? startOf(level) : counters[level] + 1);
    counters.length = level + 1;
    const format = attr(levelStyle, 'style', 'num-format') ?? '';
    const display = Math.min(level, Math.max(1, Number(attr(levelStyle, 'text', 'display-levels')) || 1));
    const parts = [];
    for (let depth = level - display + 1; depth <= level; depth++) {
      const depthFormat = attr(levelStyleOf(listStyle, depth), 'style', 'num-format') ?? '';
      if (depthFormat) parts.push(formatNumber(counters[depth] ?? startOf(depth), depthFormat));
    }
    if (!format && !parts.length) return `${attr(levelStyle, 'style', 'num-prefix') || ''}${attr(levelStyle, 'style', 'num-suffix') || ''}`.trim();
    return `${attr(levelStyle, 'style', 'num-prefix') || ''}${parts.join('.')}${attr(levelStyle, 'style', 'num-suffix') || ''}`;
  };
  const listIndent = (listStyle, level) => {
    const properties = firstChild(levelStyleOf(listStyle, level), 'style', 'list-level-properties');
    const alignment = firstChild(properties, 'style', 'list-level-label-alignment');
    if (alignment) {
      const start = toPx(attr(alignment, 'fo', 'margin-left'), level * 24);
      return { start, label: Math.max(0, -toPx(attr(alignment, 'fo', 'text-indent'), -24)) };
    }
    const label = toPx(attr(properties, 'text', 'min-label-width'), 24);
    return { start: toPx(attr(properties, 'text', 'space-before'), (level - 1) * 24) + label, label };
  };
  const listKey = (name) => `list:${name || ''}`;
  const convertListItems = (list, level, inheritedStyle, onItem) => {
    const styleName = attr(list, 'text', 'style-name') || inheritedStyle;
    const listStyle = styleSheet.listStyle(context.scope, styleName);
    if (level === 1 && attr(list, 'text', 'continue-numbering') !== 'true' && !attr(list, 'text', 'continue-list')) context.counters.delete(listKey(styleName));
    const indent = listIndent(listStyle, level);
    const outer = level > 1 ? listIndent(listStyle, level - 1).start : 0;
    for (const item of childElements(list)) {
      if (!is(item, 'text', 'list-item', 'list-header')) continue;
      const element = applyCss(html('div'), { 'padding-left': `${Math.max(0, indent.start - outer)}px` });
      const restart = Number(attr(item, 'text', 'start-value'));
      const marker = is(item, 'text', 'list-item') ? levelMarker(listStyle, level, listKey(styleName), Number.isSafeInteger(restart) && restart > 0 ? restart : null) : '';
      for (const child of childElements(item)) {
        const converted = is(child, 'text', 'list') ? convertList(child, level + 1, styleName) : convertBlock(child);
        if (converted) element.append(converted);
      }
      if (marker) {
        const label = applyCss(html('span'), { display: 'inline-block', 'min-width': `${indent.label}px`, 'margin-left': `-${indent.label}px`, 'text-indent': '0' });
        label.textContent = `${marker} `;
        const first = element.firstElementChild?.tagName === 'P' ? element.firstElementChild : null;
        if (first) { first.style.textIndent = '0'; first.prepend(label); } else element.prepend(label);
        const firstSource = childElements(item).find(child => is(child, 'text', 'p', 'h'));
        if (first && firstSource) listLabels.set(firstSource, listLabels.has(firstSource) ? `${marker} ${listLabels.get(firstSource)}` : marker);
      }
      onItem(item, element);
    }
  };
  const convertList = (list, level = 1, inheritedStyle = null) => {
    const container = html('div');
    convertListItems(list, level, inheritedStyle, (item, element) => container.append(element));
    return container;
  };

  const tableModel = (table, rowsOnly = false) => {
    const resolved = styleSheet.resolve(context.scope, 'table', attr(table, 'table', 'style-name'));
    const columns = [];
    const relativeColumns = [];
    const headerRows = [];
    const rows = [];
    let pendingBreak = false;
    const visit = (node, header) => {
      for (const child of childElements(node)) {
        if (is(child, 'table', 'table-column')) {
          const repeat = Math.min(MAX_TABLE_COLUMNS - columns.length, Math.max(1, Number(attr(child, 'table', 'number-columns-repeated')) || 1));
          const properties = styleSheet.resolve(context.scope, 'table-column', attr(child, 'table', 'style-name')).column;
          const width = properties['style:column-width'];
          const relative = Number(/^(\d+(?:\.\d+)?)\*$/.exec(properties['style:rel-column-width'] || '')?.[1]) || null;
          for (let index = 0; index < repeat; index++) { columns.push(isLength(width) ? width : null); relativeColumns.push(relative); }
        } else if (is(child, 'table', 'table-columns', 'table-header-columns', 'table-column-group')) visit(child, header);
        else if (is(child, 'table', 'table-header-rows')) visit(child, true);
        else if (is(child, 'table', 'table-rows', 'table-row-group')) visit(child, header);
        else if (is(child, 'text', 'soft-page-break')) pendingBreak = true;
        else if (is(child, 'table', 'table-row')) {
          (header ? headerRows : rows).push({ source: child, softBreak: pendingBreak && !header });
          pendingBreak = false;
        }
      }
    };
    visit(table, false);
    if (rowsOnly) return { rows };
    const tableCss = boxCss(resolved.table, {});
    if (isLength(resolved.table['style:width'])) tableCss.width = resolved.table['style:width'];
    // "margins" alignment spans the text width; columns with only relative widths share it.
    if (resolved.table['table:align'] === 'margins' || !resolved.table['table:align'] && !tableCss.width && relativeColumns.length && relativeColumns.every(Boolean)) tableCss.width = '100%';
    if (columns.length && !columns.every(Boolean) && relativeColumns.every(Boolean)) {
      const total = relativeColumns.reduce((sum, value) => sum + value, 0);
      columns.splice(0, columns.length, ...relativeColumns.map(value => `${Math.round(value / total * 10000) / 100}%`));
    }
    if (resolved.table['table:align'] === 'center') Object.assign(tableCss, { 'margin-left': 'auto', 'margin-right': 'auto' });
    if (resolved.table['table:align'] === 'right') tableCss['margin-left'] = 'auto';
    if (tableCss.width && columns.length && columns.every(Boolean)) tableCss['table-layout'] = 'fixed';
    let headerTemplate = null;
    if (headerRows.length) {
      headerTemplate = html('thead');
      for (const row of headerRows) for (const converted of convertRow(row.source)) headerTemplate.append(converted);
    }
    const create = () => {
      const element = applyCss(html('table'), tableCss);
      if (columns.some(Boolean)) {
        const group = html('colgroup');
        for (const width of columns) group.append(width ? applyCss(html('col'), { width }) : html('col'));
        element.append(group);
      }
      if (headerTemplate) {
        countTableElements(elementCount(headerTemplate));
        element.append(cloneMapped(headerTemplate, sourceOf));
      }
      const body = html('tbody');
      element.append(body);
      return { element, target: body };
    };
    return { resolved, rows, create };
  };
  const convertRow = (row) => {
    const rowProperties = styleSheet.resolve(context.scope, 'table-row', attr(row, 'table', 'style-name')).row;
    const element = html('tr');
    const height = rowProperties['style:row-height'] || rowProperties['style:min-row-height'];
    if (isLength(height)) element.style.height = height;
    let columns = 0;
    for (const cell of childElements(row)) {
      if (!is(cell, 'table', 'table-cell')) continue;
      const repeat = Math.min(MAX_TABLE_COLUMNS - columns, Math.max(1, Number(attr(cell, 'table', 'number-columns-repeated')) || 1));
      const td = applyCss(html('td'), cellCss(styleSheet.resolve(context.scope, 'table-cell', attr(cell, 'table', 'style-name')).cell));
      const columnSpan = Number(attr(cell, 'table', 'number-columns-spanned'));
      const rowSpan = Number(attr(cell, 'table', 'number-rows-spanned'));
      if (columnSpan > 1) td.colSpan = Math.min(columnSpan, MAX_TABLE_COLUMNS);
      if (rowSpan > 1) td.rowSpan = Math.min(rowSpan, 1000);
      for (const child of childElements(cell)) {
        const converted = convertBlock(child);
        if (converted) td.append(converted);
      }
      const size = elementCount(td);
      countTableElements(size);
      element.append(td);
      for (let index = 1; index < repeat; index++) {
        countTableElements(size);
        element.append(cloneMapped(td, sourceOf));
      }
      columns += repeat;
    }
    const repeated = Math.min(MAX_REPEATED_ROWS, Math.max(1, Number(attr(row, 'table', 'number-rows-repeated')) || 1));
    countTableElements(elementCount(element) * (repeated - 1));
    return [element, ...Array.from({ length: repeated - 1 }, () => cloneMapped(element, sourceOf))];
  };
  const convertTable = (table) => {
    const model = tableModel(table);
    const { element, target } = model.create();
    for (const row of model.rows) for (const converted of convertRow(row.source)) target.append(converted);
    return element;
  };

  const convertBlock = (node) => {
    if (isSkipped(node)) return null;
    if (is(node, 'text', 'p', 'h')) return paragraph(node);
    if (is(node, 'text', 'list')) return convertList(node);
    if (is(node, 'table', 'table')) return convertTable(node);
    if (is(node, 'draw', 'frame')) return frame(node);
    if (node.namespaceURI === NS.draw && SHAPES.has(node.localName)) return shape(node);
    const container = html('div');
    // Indexes keep their generated body; sections and unknown containers keep their children.
    const indexBody = firstChild(node, 'text', 'index-body');
    for (const child of indexBody ? childElements(indexBody) : childElements(node)) {
      const converted = convertBlock(child);
      if (converted) container.append(converted);
    }
    return container.childNodes.length ? container : null;
  };

  // A soft page break before any content means the node starts a new page;
  // one after content means the node continues onto the next page.
  const softBreakPosition = (node) => {
    const softBreak = node.getElementsByTagNameNS(NS.text, 'soft-page-break')[0];
    if (!softBreak) return null;
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION);
    for (let current = walker.nextNode(); current && current !== softBreak; current = walker.nextNode()) {
      if (current.nodeType !== Node.ELEMENT_NODE ? current.textContent.trim() : is(current, 'text', 'tab', 's') || is(current, 'draw', 'frame')) return 'inside';
    }
    return 'before';
  };
  const firstParagraph = (node) => is(node, 'text', 'p', 'h') ? node : [...node.getElementsByTagName('*')].find(child => is(child, 'text', 'p', 'h')) || null;
  const styleBreaks = (node) => {
    const resolved = is(node, 'table', 'table')
      ? styleSheet.resolve('content', 'table', attr(node, 'table', 'style-name'))
      : styleSheet.resolve('content', 'paragraph', attr(firstParagraph(node), 'text', 'style-name'));
    const properties = is(node, 'table', 'table') ? resolved.table : resolved.paragraph;
    return { before: properties['fo:break-before'] === 'page', after: properties['fo:break-after'] === 'page', master: resolved.masterPageName };
  };

  const pieces = [];
  const addPiece = (piece, source, breaks) => {
    const position = softBreakPosition(source);
    pieces.push({ ...piece, source, softBefore: position === 'before', softAfter: position === 'inside', ...breaks });
  };
  let pendingSoftBreak = false;
  const visitBody = (node) => {
    for (const child of childElements(node)) {
      signal?.throwIfAborted();
      if (is(child, 'text', 'soft-page-break')) { pendingSoftBreak = true; continue; }
      if (isSkipped(child)) continue;
      if (is(child, 'text', 'section')) {
        // A section with columns draws its paragraphs in a column box; lists and tables inside stay full width.
        const columns = styleSheet.sectionColumns(attr(child, 'text', 'style-name'));
        const saved = context.columns;
        if (columns) context.columns = { create: () => { const element = applyCss(html('div', 'doc-columns'), columns); return { element, target: element }; } };
        visitBody(child);
        context.columns = saved;
        continue;
      }
      if (child.namespaceURI === NS.text && firstChild(child, 'text', 'index-body')) { visitBody(firstChild(child, 'text', 'index-body')); continue; }
      const breaks = styleBreaks(child);
      const softBefore = pendingSoftBreak;
      pendingSoftBreak = false;
      if (is(child, 'text', 'list')) {
        const group = { create: () => { const element = html('div'); return { element, target: element }; } };
        let first = true;
        convertListItems(child, 1, null, (item, element) => {
          addPiece({ element, group, notes: context.notes, softBreak: first && softBefore }, item, first ? { before: breaks.before, master: breaks.master } : {});
          context.notes = [];
          first = false;
        });
        if (pieces.at(-1)?.group === group && breaks.after) pieces.at(-1).after = true;
      } else if (is(child, 'table', 'table') && !tableModel(child, true).rows.length) {
        const element = convertTable(child);
        addPiece({ element, notes: context.notes, softBreak: softBefore }, child, breaks);
        context.notes = [];
      } else if (is(child, 'table', 'table')) {
        const model = tableModel(child);
        model.rows.forEach((row, index) => {
          const converted = convertRow(row.source);
          const element = converted.length === 1 ? converted[0] : converted;
          addPiece({ element, group: model, notes: context.notes, trimTop: true, softBreak: index ? row.softBreak : softBefore || row.softBreak }, row.source,
            { ...(index ? {} : { before: breaks.before, master: breaks.master }), ...(index === model.rows.length - 1 ? { after: breaks.after } : {}) });
          context.notes = [];
        });
      } else {
        const element = convertBlock(child);
        // A paragraph holding only a frame that need not follow the text flow may hang into the bottom margin.
        const overhang = element?.tagName === 'P' && !element.textContent.replace(/​/g, '').trim() &&!!element.querySelector('[data-overhang]');
        // fo:orphans and fo:widows (lines kept on each side of a page break, none when absent);
        // fo:keep-together keeps the paragraph whole. Like Writer, a paragraph moved to the top
        // of a page by a natural break loses its spacing above.
        const properties = is(child, 'text', 'p', 'h') ? styleSheet.resolve('content', 'paragraph', attr(child, 'text', 'style-name')).paragraph : {};
        const count = (name) => /^\d{1,2}$/.test(properties[name] || '') ? Math.max(1, Number(properties[name])) : 1;
        const lines = properties['fo:keep-together'] === 'always' ? { orphans: 1000 } : { orphans: count('fo:orphans'), widows: count('fo:widows') };
        if (element) addPiece({ element, notes: context.notes, softBreak: softBefore, trimTop: true, ...lines, ...(context.columns ? { group: context.columns } : {}), ...(overhang ? { overhang } : {}) }, child, breaks);
        else if (softBefore) pendingSoftBreak = true;
        context.notes = [];
      }
    }
  };
  const officeText = content.getElementsByTagNameNS(NS.office, 'text')[0];
  if (!officeText) throw new Error('Invalid ODT XML.');
  context.notes = [];
  visitBody(officeText);
  // Writer collects endnotes on their own page after the body, in the page style its
  // endnote configuration names (text:master-page-name, "Endnote" by default).
  if (context.endnotes.length) {
    const configuration = [...styles?.getElementsByTagNameNS(NS.text, 'notes-configuration') || []].find(node => attr(node, 'text', 'note-class') === 'endnote');
    const master = attr(configuration, 'text', 'master-page-name') || 'Endnote';
    context.endnotes.forEach((endnote, index) => pieces.push({ element: endnote.element, notes: [], source: endnote.source, ...(index ? {} : styleSheet.masters.has(master) ? { master } : { before: true }) }));
  }
  const useSoftBreaks = officeText.getElementsByTagNameNS(NS.text, 'soft-page-break').length > 0;

  const headerTemplates = new Map();
  const headerFooter = (master, name) => {
    const key = `${attr(master, 'style', 'name')}|${name}`;
    if (!headerTemplates.has(key)) {
      const part = firstChild(master, 'style', name);
      let element = null;
      if (part && attr(part, 'style', 'display') !== 'false') {
        context.scope = 'styles';
        const notes = context.notes;
        context.notes = null;
        element = html('div');
        for (const child of childElements(part)) {
          const converted = convertBlock(child);
          if (converted) element.append(converted);
        }
        context.scope = 'content';
        context.notes = notes;
      }
      headerTemplates.set(key, { element, source: part });
    }
    return headerTemplates.get(key);
  };
  const createPage = (master) => {
    const geometry = pageGeometry(styleSheet, master);
    const root = applyCss(html('div', 'doc-page'), {
      width: geometry.width, height: geometry.height,
      'padding-top': geometry.margins.top, 'padding-right': geometry.margins.right, 'padding-bottom': geometry.margins.bottom, 'padding-left': geometry.margins.left,
      'tab-size': styleSheet.tabSize, ...(geometry.background ? { 'background-color': geometry.background } : {}),
    });
    const page = { root, body: html('div', 'doc-body'), notes: html('div', 'doc-notes') };
    for (const [name, className, spacing] of [['header', 'doc-header', 'fo:margin-bottom'], ['footer', 'doc-footer', 'fo:margin-top']]) {
      const template = headerFooter(master, name);
      if (!template.element) continue;
      const properties = geometry[name];
      const element = applyCss(template.element.cloneNode(true), {
        ...(isLength(properties[spacing]) ? { [spacing.slice(3)]: properties[spacing] } : {}),
        ...(isLength(properties['fo:min-height']) ? { 'min-height': properties['fo:min-height'] } : {}),
      });
      element.className = className;
      page[name] = element;
      page[`${name}Source`] = template.source;
    }
    root.append(...[page.header, page.body, page.notes, page.footer].filter(Boolean));
    return page;
  };
  const pages = await paginateAndRender({
    pieces, useSoftBreaks, label: 'ODT', signal, encodePageImage, maxImageCharacters, pendingImages, sourceOf, pageImages, redact,
    firstStyle: styleSheet.defaultMaster,
    styleByName: (name) => styleSheet.masters.get(name) || null,
    nextStyle: (master) => styleSheet.masters.get(attr(master, 'style', 'next-style-name')) || master,
    createPage,
  });
  return { pages, imageLimitations: limitations.list(), invisibleSources: pages.invisibleSources, listLabels };
};
