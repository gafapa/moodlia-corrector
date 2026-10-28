// Office Open XML helpers shared by spreadsheets (XLSX) and presentations (PPTX):
// package parts and relationships, theme colours and fonts, DrawingML colours.
// XML is matched by local name, so unusual prefixes or namespaces still read.
import { FONT_FAMILY } from './pageLayout.js';

export const EMU_PER_PX = 9525;
export const elements = (node) => node ? [...node.childNodes].filter(item => item.nodeType === Node.ELEMENT_NODE) : [];
export const child = (node, name) => elements(node).find(item => item.localName === name) || null;
export const childrenNamed = (node, name) => elements(node).filter(item => item.localName === name);
export const descendant = (node, name) => node?.getElementsByTagNameNS('*', name)[0] || null;
export const val = (node, name = 'val') => {
  for (const attribute of node?.attributes || []) if (attribute.localName === name) return attribute.value;
  return null;
};
// r:id of a part reference; sldId also has its own unprefixed id.
export const relationId = (node) => {
  for (const attribute of node?.attributes || []) if (attribute.localName === 'id' && /relationships/.test(attribute.namespaceURI || '')) return attribute.value;
  return null;
};
export const isOn = (node, name = 'val') => !!node && !['0', 'false', 'off'].includes(val(node, name) ?? 'true');
export const parseXml = (data) => {
  if (!data) return null;
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(data), 'application/xml');
  return doc.querySelector('parsererror') ? null : doc;
};

// Parts are parsed once; relationships resolve r:id references relative to their part.
export const createPackage = (entries) => {
  const parsed = new Map();
  const parse = (path) => {
    if (!parsed.has(path)) parsed.set(path, parseXml(entries[path]));
    return parsed.get(path);
  };
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
          const resolved = [];
          for (const segment of (target.startsWith('/') ? target.slice(1) : directory + target).split('/')) {
            if (segment === '..') resolved.pop(); else if (segment && segment !== '.') resolved.push(segment);
          }
          path = resolved.join('/');
        }
        map.set(val(relation, 'Id'), { path, external, type: val(relation, 'Type') || '' });
      }
      relationships.set(part, map);
    }
    return relationships.get(part);
  };
  const related = (part, id) => id ? rels(part).get(id) || null : null;
  const relatedByType = (part, suffix) => [...rels(part).values()].filter(relation => relation.type.endsWith(suffix));
  return { parse, rels, related, relatedByType };
};

const HEX = /^[0-9a-f]{6}$/i;
export const rgbOf = (hex) => ({ r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 });
const DEFAULT_SCHEME = {
  dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6', accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5',
  accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47', hlink: '0563C1', folHlink: '954F72',
};
export const readTheme = (doc) => {
  const colors = Object.fromEntries(Object.entries(DEFAULT_SCHEME).map(([name, hex]) => [name, rgbOf(hex)]));
  for (const item of elements(descendant(doc, 'clrScheme'))) {
    const hex = val(child(item, 'srgbClr')) || val(child(item, 'sysClr'), 'lastClr');
    if (HEX.test(hex || '')) colors[item.localName] = rgbOf(hex);
  }
  const font = (kind) => val(child(descendant(doc, `${kind}Font`), 'latin'), 'typeface');
  return { colors, fonts: { major: font('major'), minor: font('minor') } };
};

const toHsl = ({ r, g, b }) => {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === red ? (green - blue) / d + (green < blue ? 6 : 0) : max === green ? (blue - red) / d + 2 : (red - green) / d + 4;
  return { h: h / 6, s, l };
};
const fromHsl = ({ h, s, l }, a) => {
  if (!s) return { r: l * 255, g: l * 255, b: l * 255, a };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
  };
  return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255, a };
};
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
// Excel tints change the HSL lightness: negative darkens, positive lightens.
export const tintColor = (color, tint) => {
  if (!tint) return color;
  const hsl = toHsl(color);
  hsl.l = tint < 0 ? hsl.l * (1 + tint) : hsl.l * (1 - tint) + tint;
  return fromHsl({ ...hsl, l: clamp(hsl.l, 0, 1) }, color.a);
};
const applyModifiers = (color, node) => {
  let result = { ...color };
  for (const modifier of elements(node)) {
    const amount = Number(val(modifier)) / 100000;
    if (!Number.isFinite(amount)) continue;
    const name = modifier.localName;
    if (name === 'alpha') result.a = clamp(amount, 0, 1);
    else if (name === 'tint') for (const key of ['r', 'g', 'b']) result[key] = result[key] * amount + 255 * (1 - amount);
    else if (name === 'shade') for (const key of ['r', 'g', 'b']) result[key] *= amount;
    else if (['lumMod', 'lumOff', 'satMod'].includes(name)) {
      const hsl = toHsl(result);
      if (name === 'lumMod') hsl.l *= amount; else if (name === 'lumOff') hsl.l += amount; else hsl.s *= amount;
      result = fromHsl({ h: hsl.h, s: clamp(hsl.s, 0, 1), l: clamp(hsl.l, 0, 1) }, result.a);
    }
  }
  for (const key of ['r', 'g', 'b']) result[key] = clamp(Math.round(result[key]), 0, 255);
  return result;
};
const PRESET_COLORS = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500', navy: '000080' };
const COLOR_NODES = new Set(['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr']);
// A colour container (solidFill, buClr, a:fgClr...) to {r, g, b, a}. The context holds
// the theme colours, the master's colour map and the colour of a style reference (phClr).
export const resolveColor = (container, context = {}) => {
  const node = COLOR_NODES.has(container?.localName) ? container : elements(container).find(item => COLOR_NODES.has(item.localName));
  if (!node) return null;
  let base = null;
  if (node.localName === 'srgbClr') base = HEX.test(val(node) || '') ? rgbOf(val(node)) : null;
  else if (node.localName === 'sysClr') base = rgbOf(HEX.test(val(node, 'lastClr') || '') ? val(node, 'lastClr') : val(node) === 'window' ? 'FFFFFF' : '000000');
  else if (node.localName === 'prstClr') base = PRESET_COLORS[val(node)] ? rgbOf(PRESET_COLORS[val(node)]) : null;
  else if (node.localName === 'scrgbClr') {
    const linear = (name) => clamp(Number(val(node, name)) / 100000, 0, 1) || 0;
    const encode = (value) => 255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055);
    base = { r: encode(linear('r')), g: encode(linear('g')), b: encode(linear('b')), a: 1 };
  } else {
    const name = val(node);
    if (name === 'phClr') base = context.placeholderColor || null;
    else {
      const mapped = context.map?.[name] || { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }[name] || name;
      base = context.colors?.[mapped] || null;
    }
  }
  return base ? applyModifiers(base, node) : null;
};
// Colours become CSS only from numbers, so no file value reaches a style unchecked.
export const colorCss = (color) => {
  if (!color) return null;
  const [r, g, b] = ['r', 'g', 'b'].map(key => clamp(Math.round(color.r === undefined ? 0 : color[key]), 0, 255));
  return color.a >= 0.999 ? `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}` : `rgba(${r}, ${g}, ${b}, ${Math.round(clamp(color.a, 0, 1) * 1000) / 1000})`;
};
export const fontStack = (name, fallback = 'sans-serif') => {
  const clean = (name || '').replace(/['",]/g, '').trim();
  if (!clean || !FONT_FAMILY.test(clean)) return null;
  const generic = /mono|courier|consol/i.test(clean) ? 'monospace' : /times|georgia|garamond|cambria|serif$|roman|book/i.test(clean) && !/sans/i.test(clean) ? 'serif' : fallback;
  return `'${clean}', ${generic}`;
};
