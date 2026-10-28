// Spreadsheets (XLSX and ODS) printed the way a spreadsheet application prints
// them with gridlines and headings: each visible sheet becomes landscape A4 pages
// of its used range, with column letters repeated at the top of every page and
// row numbers on the left. Columns that do not fit the page width continue on
// the following pages ("down, then over"), so text keeps its size. Runs of more
// than 10 empty rows or 4 empty columns collapse into one marker row or column.
// Cells show their saved (cached) value; the extracted text lists every
// non-empty cell with its reference and, for formulas, the formula.
import { BORDER, FONT_FAMILY, applyCss, createImageSources, createLimitations, html, imageLoaded, isColor, isLength, mappedText, paginateAndRender, placeholder, toPx } from './pageLayout.js';
import { EMU_PER_PX, child, childrenNamed, colorCss, createPackage, descendant, elements, fontStack, isOn, readTheme, relationId, resolveColor, rgbOf, tintColor, val } from './drawingml.js';

export const MAX_SHEET_CELLS = 10_000;
const MAX_TABLE_ELEMENTS = 200_000;
const MAX_STYLED_CELLS = 100_000;
const MAX_MERGE_CELLS = 10_000;
const MAX_DRAWINGS = 500;
const MAX_ROW = 1_048_576;
const MAX_COLUMN = 16_384;
const EMPTY_ROW_RUN = 10;
const EMPTY_COLUMN_RUN = 4;
const MAX_SPANNED_ROWS = 60;
const PAGE_WIDTH_MM = 297;
const PAGE_HEIGHT_MM = 210;
const PAGE_MARGIN_MM = 10;
const HEADER_WIDTH = 40;
const GAP_WIDTH = 30;
const CONTENT_WIDTH = (PAGE_WIDTH_MM - 2 * PAGE_MARGIN_MM) * 96 / 25.4 - HEADER_WIDTH - 8;
const pageLimit = (message) => Object.assign(new Error(message), { code: 'PAGE_LIMIT' });
const key = (row, column) => row * MAX_COLUMN + column;

export const columnName = (index) => {
  let name = '';
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) name = String.fromCharCode(65 + (rest - 1) % 26) + name;
  return name;
};
export const cellReference = (row, column) => `${columnName(column)}${row + 1}`;
const parseReference = (reference) => {
  const match = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(reference || '');
  if (!match) return null;
  let column = 0;
  for (const letter of match[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  return { row: Number(match[2]) - 1, column: column - 1 };
};

// Number formats: the built-in Excel codes and custom codes for numbers, percentages,
// fixed decimals, thousands separators, scientific notation, dates and times. Built-in
// dates use ISO order (2026-10-28) instead of the computer's regional short date.
const BUILTIN_FORMATS = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: 'General', 13: 'General',
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'yyyy-mm-dd h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;(#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;(#,##0.00)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const splitSections = (code) => {
  const sections = [''];
  let quoted = false;
  for (let index = 0; index < code.length; index++) {
    const character = code[index];
    if (character === '\\' && !quoted) { sections[sections.length - 1] += character + (code[index + 1] ?? ''); index++; continue; }
    if (character === '"') quoted = !quoted;
    if (character === ';' && !quoted) sections.push(''); else sections[sections.length - 1] += character;
  }
  return sections;
};
const generalNumber = (value) => {
  const size = Math.abs(value);
  if (size && (size >= 1e11 || size < 1e-4)) return value.toExponential(5).replace(/\.?0+e/, 'e').replace(/e([+-])(\d)$/, 'e$10$2').toUpperCase();
  return String(Number(value.toPrecision(10)));
};
// Literal parts of a section: quoted text, escaped characters, spacing (_x) and currency tags.
const sectionCharacters = (section) => {
  const characters = [];
  for (let index = 0; index < section.length; index++) {
    const character = section[index];
    if (character === '"') {
      const end = section.indexOf('"', index + 1);
      for (const literal of section.slice(index + 1, end < 0 ? undefined : end)) characters.push({ character: literal, literal: true });
      index = end < 0 ? section.length : end;
    } else if (character === '\\') { if (index + 1 < section.length) characters.push({ character: section[++index], literal: true }); }
    else if (character === '_') { index++; characters.push({ character: ' ', literal: true }); }
    else if (character === '*') index++;
    else if (character === '[') {
      const end = section.indexOf(']', index);
      const symbol = /^\$([^-\]]*)/.exec(section.slice(index + 1, end < 0 ? undefined : end))?.[1] || '';
      for (const literal of symbol) characters.push({ character: literal, literal: true });
      index = end < 0 ? section.length : end;
    } else characters.push({ character, literal: false });
  }
  return characters;
};
const formatNumberSection = (value, section, negative) => {
  const characters = sectionCharacters(section).filter(item => item.literal || item.character !== '@');
  const mask = characters.map(item => item.literal ? '\u0000' : item.character).join('');
  const match = /[0#?][0#?,]*(?:\.[0#?]*)?(?:[Ee][+-][0#?]+)?|\.[0#?]+(?:[Ee][+-][0#?]+)?/.exec(mask);
  const text = (from, to) => characters.slice(from, to).map(item => item.character).join('');
  if (!match) return `${negative ? '-' : ''}${text(0)}`;
  let scaled = Math.abs(value) * 100 ** (mask.match(/%/g) || []).length;
  const [mantissa, exponentPattern] = match[0].split(/[Ee](?=[+-])/);
  let [integerPattern, decimalPattern = ''] = mantissa.split('.');
  if (!mantissa.includes('.')) {
    const trailing = /,+$/.exec(integerPattern)?.[0].length || 0;
    scaled /= 1000 ** trailing;
    integerPattern = integerPattern.replace(/,+$/, '');
  }
  const decimals = decimalPattern.replace(/[^0#?]/g, '').length;
  const minimumDecimals = (decimalPattern.match(/0/g) || []).length;
  const minimumInteger = (integerPattern.match(/0/g) || []).length;
  let exponent = '';
  if (exponentPattern !== undefined) {
    let power = scaled ? Math.floor(Math.log10(scaled)) : 0;
    const integerDigits = Math.max(1, integerPattern.replace(/[^0#?]/g, '').length);
    if (integerDigits > 1 && integerPattern.includes('#')) power = Math.floor(power / integerDigits) * integerDigits;
    scaled /= 10 ** power;
    exponent = `E${power < 0 ? '-' : exponentPattern[0] === '+' ? '+' : ''}${String(Math.abs(power)).padStart(exponentPattern.length - 1, '0')}`;
  }
  let [integerText, decimalText = ''] = scaled.toFixed(Math.min(decimals, 20)).split('.');
  decimalText = decimalText.replace(/0+$/, '').padEnd(minimumDecimals, '0');
  if (integerText === '0' && !minimumInteger) integerText = '';
  integerText = integerText.padStart(minimumInteger, '0');
  if (integerPattern.includes(',')) integerText = integerText.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const number = `${integerText}${mantissa.includes('.') && (decimalText || !minimumDecimals) ? '.' : ''}${decimalText}${exponent}`;
  return `${negative ? '-' : ''}${text(0, match.index)}${number}${text(match.index + match[0].length)}`;
};
const DATE_TOKEN = /"[^"]*"|\\.|\[h+\]|\[m+\]|\[s+\]|\[[^\]]*\]|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am\/pm|a\/p|\.0+|_.|\*.|./gi;
const isDateSection = (section) => /[ymdhs]/i.test(section.replace(/"[^"]*"|\\.|_.|\*.|\[(?![hms]+\])[^\]]*\]/gi, '').replace(/e[+-]/gi, ''));
const formatDate = (serial, section, date1904) => {
  if (serial < 0 || serial > 2958466) return '#######';
  const days = Math.floor(serial);
  const fraction = serial - days;
  const base = date1904 ? Date.UTC(1904, 0, 1) : serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const tokens = section.match(DATE_TOKEN) || [];
  const precision = Math.max(0, ...tokens.filter(token => /^\.0+$/.test(token)).map(token => token.length - 1));
  const milliseconds = Math.round(fraction * 86400 * 10 ** precision) * 1000 / 10 ** precision;
  const date = new Date(base + days * 86_400_000 + milliseconds);
  const twelveHour = tokens.some(token => /^(?:am\/pm|a\/p)$/i.test(token));
  const lower = tokens.map(token => /^["\\_*[]/.test(token) ? token : token.toLowerCase());
  const isMinute = (index) => {
    for (let previous = index - 1; previous >= 0; previous--) {
      if (/^(?:h+|\[h+\])$/.test(lower[previous])) return true;
      if (/^(?:[yd]+|m+|s+)$/.test(lower[previous])) break;
    }
    for (let next = index + 1; next < lower.length; next++) {
      if (/^(?:s+|\[s+\])$/.test(lower[next])) return true;
      if (/^(?:[ydh]+|m+)$/.test(lower[next])) break;
    }
    return false;
  };
  const totalSeconds = serial * 86400;
  return lower.map((token, index) => {
    const pad = (value, length) => String(value).padStart(length, '0');
    const hours = date.getUTCHours();
    switch (token) {
      case 'yyyy': return pad(date.getUTCFullYear(), 4);
      case 'yy': return pad(date.getUTCFullYear() % 100, 2);
      case 'mmmmm': return MONTHS[date.getUTCMonth()][0];
      case 'mmmm': return MONTHS[date.getUTCMonth()];
      case 'mmm': return MONTHS[date.getUTCMonth()].slice(0, 3);
      case 'mm': return isMinute(index) ? pad(date.getUTCMinutes(), 2) : pad(date.getUTCMonth() + 1, 2);
      case 'm': return isMinute(index) ? String(date.getUTCMinutes()) : String(date.getUTCMonth() + 1);
      case 'dddd': return DAYS[date.getUTCDay()];
      case 'ddd': return DAYS[date.getUTCDay()].slice(0, 3);
      case 'dd': return pad(date.getUTCDate(), 2);
      case 'd': return String(date.getUTCDate());
      case 'hh': return pad(twelveHour ? (hours % 12 || 12) : hours, 2);
      case 'h': return String(twelveHour ? (hours % 12 || 12) : hours);
      case 'ss': return pad(date.getUTCSeconds(), 2);
      case 's': return String(date.getUTCSeconds());
      case 'am/pm': return hours < 12 ? 'AM' : 'PM';
      case 'a/p': return hours < 12 ? 'A' : 'P';
      default:
        if (/^\[h+\]$/.test(token)) return String(Math.floor(totalSeconds / 3600 + 1e-9));
        if (/^\[m+\]$/.test(token)) return String(Math.floor(totalSeconds / 60 + 1e-9));
        if (/^\[s+\]$/.test(token)) return String(Math.round(totalSeconds));
        if (/^\.0+$/.test(token)) return `.${pad(date.getUTCMilliseconds(), 3).slice(0, token.length - 1)}`;
        if (token.startsWith('"')) return token.slice(1, -1);
        if (token.startsWith('\\')) return token.slice(1);
        if (token.startsWith('_')) return ' ';
        if (token.startsWith('*')) return '';
        if (token.startsWith('[')) return /^\[\$([^-\]]*)/.exec(token)?.[1] || '';
        return token;
    }
  }).join('');
};
// Formats a cell value with an Excel number format code, as the cell shows it.
export const formatSpreadsheetValue = (value, code = 'General', { date1904 = false } = {}) => {
  const sections = splitSections(code || 'General');
  if (typeof value === 'string') {
    if (sections.length < 4) return sections.length === 1 && sections[0].includes('@') ? sectionCharacters(sections[0]).map(item => item.character === '@' && !item.literal ? value : item.character).join('') : value;
    return sectionCharacters(sections[3]).map(item => item.character === '@' && !item.literal ? value : item.character).join('');
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (!Number.isFinite(value)) return '#NUM!';
  let section = sections[0];
  let ownSign = false;
  if (value < 0 && sections.length > 1 && sections[1] !== undefined) { section = sections[1]; ownSign = true; }
  else if (value === 0 && sections.length > 2) section = sections[2];
  section = section.replace(/^\[[<>=]+-?[\d.]+\]/, '');
  if (/^\s*general\s*$/i.test(section.replace(/\[[^\]]*\]/g, ''))) return ownSign ? generalNumber(-value) : generalNumber(value);
  if (!section.trim()) return '';
  if (isDateSection(section)) return formatDate(value, section.replace(/\[(?:red|black|blue|green|white|yellow|cyan|magenta|color\s*\d+)\]/gi, ''), date1904);
  return formatNumberSection(value, section.replace(/\[(?:red|black|blue|green|white|yellow|cyan|magenta|color\s*\d+)\]/gi, ''), value < 0 && !ownSign);
};

// A shared formula is stored once; the other cells move its relative references.
export const shiftFormula = (formula, rows, columns) => formula.replace(/("(?:[^"]|"")*")|('(?:[^']|'')*'!)|(?<![A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(])/g,
  (match, string, sheet, columnLock, column, rowLock, row) => {
    if (string || sheet) return match;
    const reference = parseReference(`${column}${row}`);
    if (!reference) return match;
    const newColumn = columnLock ? reference.column : reference.column + columns;
    const newRow = rowLock ? reference.row : reference.row + rows;
    if (newColumn < 0 || newRow < 0 || newColumn >= MAX_COLUMN || newRow >= MAX_ROW) return '#REF!';
    return `${columnLock}${columnName(newColumn)}${rowLock}${newRow + 1}`;
  });
// OpenFormula ("of:=SUM([.B1:.B2])") as a spreadsheet shows it ("=SUM(B1:B2)").
export const odsFormula = (formula) => {
  const body = (formula || '').replace(/^[a-z]+:(?==)/i, '');
  return body.replace(/("(?:[^"]|"")*")|\[([^\]]*)\]/g, (match, string, reference) => string ?? reference.split(':')
    .map(part => part.replace(/^\$?((?:'(?:[^']|'')*'|[^.]*?))\.(\$?[A-Z]+\$?\d+|\$?[A-Z]+|\$?\d+)$/i, (whole, sheet, cell) => sheet ? `${sheet}!${cell}` : cell))
    .join(':'));
};

const EXCEL_THEME = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
const INDEXED = ('000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
  '800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF ' +
  '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 ' +
  '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333').split(' ');
const BORDER_STYLES = {
  thin: '0.75pt solid', medium: '1.5pt solid', thick: '2.25pt solid', hair: '0.5pt solid', dotted: '0.75pt dotted', dashed: '0.75pt dashed',
  double: '2.25pt double', mediumDashed: '1.5pt dashed', dashDot: '0.75pt dashed', mediumDashDot: '1.5pt dashed', dashDotDot: '0.75pt dotted',
  mediumDashDotDot: '1.5pt dotted', slantDashDot: '1.5pt dashed',
};
const ALIGN = { left: 'left', center: 'center', right: 'right', justify: 'justify', fill: 'left', centerContinuous: 'center', distributed: 'justify', start: 'left', end: 'right' };

const textLimit = (label) => new Error(`${label} exceeds the text or image limit.`);
const createBudget = (label, maxText) => {
  let cells = 0;
  let text = 0;
  return {
    cell: (count = 1) => {
      cells += count;
      if (cells > MAX_SHEET_CELLS) throw pageLimit(`${label} exceeds the 10,000 non-empty cell limit.`);
    },
    text: (length) => {
      text += length;
      if (text > maxText) throw textLimit(label);
    },
  };
};
const runsText = (runs) => runs.map(run => run.text).join('');

// ---- XLSX ----
export const readXlsxWorkbook = ({ entries, signal, sniffFormat, bitmapDimensions, bytesToBase64, maxPixels, maxText = Infinity }) => {
  const label = 'XLSX';
  const pkg = createPackage(entries);
  const workbookPath = [...pkg.rels('').values()].find(relation => relation.type.endsWith('/officeDocument'))?.path || 'xl/workbook.xml';
  const workbookDoc = pkg.parse(workbookPath);
  if (!workbookDoc) throw new Error('Invalid XLSX XML.');
  const budget = createBudget(label, maxText);
  const limitations = createLimitations();
  const hidden = { count: 0 };
  const imageSource = createImageSources({ entries, sniffFormat, bitmapDimensions, bytesToBase64, maxPixels });
  const date1904 = isOn(descendant(workbookDoc, 'workbookPr'), 'date1904') && val(descendant(workbookDoc, 'workbookPr'), 'date1904') !== null;
  const theme = readTheme(pkg.parse(pkg.relatedByType(workbookPath, '/theme')[0]?.path || 'xl/theme/theme1.xml'));
  const excelColor = (node) => {
    if (!node || val(node, 'auto') === '1') return null;
    let color = null;
    const rgb = val(node, 'rgb');
    if (/^[0-9a-f]{8}$/i.test(rgb || '')) color = rgbOf(rgb.slice(2));
    else if (/^[0-9a-f]{6}$/i.test(rgb || '')) color = rgbOf(rgb);
    else if (val(node, 'theme') !== null) color = theme.colors[EXCEL_THEME[Number(val(node, 'theme'))]] || null;
    else if (val(node, 'indexed') !== null) {
      const index = Number(val(node, 'indexed'));
      color = INDEXED[index] ? rgbOf(INDEXED[index]) : index === 64 ? rgbOf('000000') : null;
    }
    const tint = Number(val(node, 'tint'));
    return color && Number.isFinite(tint) ? tintColor(color, Math.max(-1, Math.min(1, tint))) : color;
  };
  const fontCss = (font) => {
    const css = {};
    if (!font) return css;
    if (child(font, 'b')) css['font-weight'] = isOn(child(font, 'b')) ? 'bold' : 'normal';
    if (child(font, 'i')) css['font-style'] = isOn(child(font, 'i')) ? 'italic' : 'normal';
    const lines = [];
    if (child(font, 'u') && val(child(font, 'u')) !== 'none') lines.push('underline');
    if (isOn(child(font, 'strike'))) lines.push('line-through');
    if (lines.length) css['text-decoration-line'] = lines.join(' ');
    const size = Number(val(child(font, 'sz')));
    if (size > 0 && size < 410) css['font-size'] = `${size}pt`;
    const color = colorCss(excelColor(child(font, 'color')));
    if (color) css.color = color;
    const family = fontStack(val(child(font, 'name')) || val(child(font, 'rFont')));
    if (family) css['font-family'] = family;
    const position = val(child(font, 'vertAlign'));
    if (position === 'superscript' || position === 'subscript') {
      css['vertical-align'] = position === 'superscript' ? 'super' : 'sub';
      css['font-size'] = size > 0 && size < 410 ? `${Math.round(size * 65) / 100}pt` : '65%';
    }
    return css;
  };

  // Styles: number formats, fonts, fills, borders and cell formats (cellXfs).
  const stylesDoc = pkg.parse(pkg.relatedByType(workbookPath, '/styles')[0]?.path || 'xl/styles.xml');
  const numberFormats = new Map(childrenNamed(descendant(stylesDoc, 'numFmts'), 'numFmt').map(format => [Number(val(format, 'numFmtId')), val(format, 'formatCode') || 'General']));
  const fonts = childrenNamed(descendant(stylesDoc, 'fonts'), 'font');
  const fills = childrenNamed(descendant(stylesDoc, 'fills'), 'fill').map((fill) => {
    const pattern = child(fill, 'patternFill');
    if (pattern && val(pattern, 'patternType') && val(pattern, 'patternType') !== 'none') return colorCss(excelColor(child(pattern, 'fgColor')) || (val(pattern, 'patternType') === 'solid' ? null : excelColor(child(pattern, 'bgColor'))));
    const stop = descendant(child(fill, 'gradientFill'), 'stop');
    return stop ? colorCss(excelColor(child(stop, 'color'))) : null;
  });
  const borders = childrenNamed(descendant(stylesDoc, 'borders'), 'border').map((border) => {
    const css = {};
    for (const [side, names] of [['left', ['left', 'start']], ['right', ['right', 'end']], ['top', ['top']], ['bottom', ['bottom']]]) {
      const edge = names.map(name => child(border, name)).find(node => val(node, 'style'));
      const style = BORDER_STYLES[val(edge, 'style')];
      if (style) css[`border-${side}`] = `${style} ${colorCss({ ...(excelColor(child(edge, 'color')) || rgbOf('000000')), a: 1 })}`;
    }
    return css;
  });
  const baseFont = fontCss(fonts[0]);
  const formats = childrenNamed(descendant(stylesDoc, 'cellXfs'), 'xf').map((xf) => {
    const alignment = child(xf, 'alignment');
    const numberFormatId = Number(val(xf, 'numFmtId')) || 0;
    const css = { ...fontCss(fonts[Number(val(xf, 'fontId')) || 0]), ...(borders[Number(val(xf, 'borderId')) || 0] || {}) };
    const fill = fills[Number(val(xf, 'fillId')) || 0];
    if (fill) css['background-color'] = fill;
    const vertical = val(alignment, 'vertical');
    css['vertical-align'] = vertical === 'top' ? 'top' : vertical === 'center' || vertical === 'distributed' || vertical === 'justify' ? 'middle' : 'bottom';
    const indent = Number(val(alignment, 'indent'));
    if (indent > 0 && indent < 100) css['padding-left'] = `${indent * 9 + 3}px`;
    return {
      css, align: ALIGN[val(alignment, 'horizontal')] || null, wrap: isOn(alignment, 'wrapText') && val(alignment, 'wrapText') !== null,
      code: numberFormats.get(numberFormatId) || BUILTIN_FORMATS[numberFormatId] || 'General',
    };
  });
  const defaultFormat = { css: { 'vertical-align': 'bottom' }, align: null, wrap: false, code: 'General' };
  const runsOf = (node) => {
    if (!node) return [];
    const runs = childrenNamed(node, 'r');
    if (!runs.length) return child(node, 't') ? [{ text: child(node, 't').textContent, css: {} }] : [];
    return runs.map(run => ({ text: childrenNamed(run, 't').map(text => text.textContent).join(''), css: fontCss(child(run, 'rPr')) })).filter(run => run.text);
  };
  const sharedStrings = childrenNamed(pkg.parse(pkg.relatedByType(workbookPath, '/sharedStrings')[0]?.path || 'xl/sharedStrings.xml')?.documentElement, 'si');

  const sheets = [];
  const sheetNodes = childrenNamed(descendant(workbookDoc, 'sheets'), 'sheet');
  for (const [sheetIndex, sheetNode] of sheetNodes.entries()) {
    signal?.throwIfAborted();
    const path = pkg.related(workbookPath, relationId(sheetNode))?.path;
    const sheetDoc = path ? pkg.parse(path) : null;
    if (!sheetDoc) continue;
    const sheetHidden = ['hidden', 'veryHidden'].includes(val(sheetNode, 'state'));
    const formatProperties = descendant(sheetDoc, 'sheetFormatPr');
    const characterWidth = (width) => Math.trunc((256 * width + Math.trunc(128 / 7)) / 256 * 7);
    const defaultWidth = Number(val(formatProperties, 'defaultColWidth')) > 0 ? characterWidth(Number(val(formatProperties, 'defaultColWidth')))
      : characterWidth((Number(val(formatProperties, 'baseColWidth')) || 8) + 0.43);
    const defaultHeight = (Number(val(formatProperties, 'defaultRowHeight')) || 15) * 4 / 3;
    const columns = childrenNamed(descendant(sheetDoc, 'cols'), 'col').map((column) => {
      const width = Number(val(column, 'width'));
      return {
        min: Math.max(1, Number(val(column, 'min')) || 1) - 1, max: Math.min(MAX_COLUMN, Number(val(column, 'max')) || 1) - 1,
        width: Number.isFinite(width) && val(column, 'width') !== null ? characterWidth(width) : defaultWidth,
        hidden: isOn(column, 'hidden') && val(column, 'hidden') !== null || (val(column, 'width') !== null && width === 0),
        style: Number(val(column, 'style')) || 0,
      };
    });
    const sheet = { name: val(sheetNode, 'name') || `Sheet${sheetIndex + 1}`, cells: new Map(), rows: new Map(), columns, defaultWidth, defaultHeight, merges: [], drawings: [], styled: 0 };
    const masters = new Map();
    let rowIndex = -1;
    for (const row of childrenNamed(descendant(sheetDoc, 'sheetData'), 'row')) {
      signal?.throwIfAborted();
      rowIndex = Number(val(row, 'r')) > 0 ? Number(val(row, 'r')) - 1 : rowIndex + 1;
      if (rowIndex >= MAX_ROW) break;
      const height = Number(val(row, 'ht'));
      const rowHidden = isOn(row, 'hidden') && val(row, 'hidden') !== null || (val(row, 'ht') !== null && height === 0);
      if (rowHidden || height > 0) sheet.rows.set(rowIndex, { hidden: rowHidden, height: height > 0 ? height * 4 / 3 : null });
      let columnIndex = -1;
      for (const cell of childrenNamed(row, 'c')) {
        const reference = parseReference(val(cell, 'r'));
        columnIndex = reference ? reference.column : columnIndex + 1;
        const cellRow = reference ? reference.row : rowIndex;
        if (columnIndex >= MAX_COLUMN || cellRow >= MAX_ROW) continue;
        const format = formats[Number(val(cell, 's')) || 0] || formats[0] || defaultFormat;
        const type = val(cell, 't') || 'n';
        const raw = child(cell, 'v')?.textContent;
        let runs = [];
        let value = null;
        if (type === 's') runs = runsOf(sharedStrings[Number(raw)]);
        else if (type === 'inlineStr') runs = runsOf(child(cell, 'is'));
        else if (type === 'str' || type === 'e') value = raw ?? '';
        else if (type === 'b') value = raw === undefined ? null : raw === '1' || raw === 'true';
        else if (type === 'd') {
          const time = Date.parse(raw || '');
          if (Number.isFinite(time)) value = (time - Date.UTC(1899, 11, 30)) / 86_400_000;
        } else if (raw !== undefined && raw.trim() !== '' && Number.isFinite(Number(raw))) value = Number(raw);
        if (runs.length && splitSections(format.code).length >= 4) runs = [{ text: formatSpreadsheetValue(runsText(runs), format.code), css: {} }];
        const stored = runs.length ? runsText(runs) : value;
        if (value !== null) {
          const text = typeof value === 'string' && type === 'e' ? value : formatSpreadsheetValue(value, format.code, { date1904 });
          runs = text ? [{ text, css: {} }] : [];
        }
        const formulaNode = child(cell, 'f');
        let formula = formulaNode?.textContent || '';
        if (val(formulaNode, 't') === 'shared') {
          const id = val(formulaNode, 'si');
          if (formula && val(formulaNode, 'ref')) masters.set(id, { formula, row: cellRow, column: columnIndex });
          else if (masters.has(id)) formula = shiftFormula(masters.get(id).formula, cellRow - masters.get(id).row, columnIndex - masters.get(id).column);
        }
        formula = formula ? `=${formula}` : null;
        const content = runs.some(run => run.text) || !!formula;
        const hiddenByFormat = !content && stored !== null && stored !== '' && stored !== undefined;
        if (!content) {
          if (hiddenByFormat) hidden.count++;
          if (format !== formats[0] && sheet.styled < MAX_STYLED_CELLS) {
            sheet.styled++;
            sheet.cells.set(key(cellRow, columnIndex), { row: cellRow, column: columnIndex, runs: [], formula: null, css: format.css, align: format.align, wrap: format.wrap, content: false });
          }
          continue;
        }
        if (sheetHidden) { hidden.count++; continue; }
        budget.cell();
        budget.text(runsText(runs).length + (formula?.length || 0));
        const kind = value === null || typeof value === 'string' ? 'text' : typeof value === 'boolean' || type === 'e' ? 'logical' : 'number';
        sheet.cells.set(key(cellRow, columnIndex), { row: cellRow, column: columnIndex, runs, formula, css: format.css, align: format.align, wrap: format.wrap, kind, content: true });
      }
    }
    if (sheetHidden) continue;
    for (const merge of childrenNamed(descendant(sheetDoc, 'mergeCells'), 'mergeCell')) {
      const [start, end] = (val(merge, 'ref') || '').split(':').map(parseReference);
      if (start && end) sheet.merges.push({ r1: Math.min(start.row, end.row), c1: Math.min(start.column, end.column), r2: Math.max(start.row, end.row), c2: Math.max(start.column, end.column) });
    }
    // Comments (notes) are printed under the rows and listed in the text; author names are left out.
    for (const relation of pkg.relatedByType(path, '/comments')) {
      for (const comment of pkg.parse(relation.path)?.getElementsByTagNameNS('*', 'comment') || []) {
        const reference = parseReference(val(comment, 'ref')?.split(':')[0]);
        if (!reference) continue;
        const runs = runsOf(child(comment, 'text'));
        if (runs.length > 1 && runs[0].css['font-weight'] === 'bold' && /:\s*$/.test(runs[0].text)) runs.shift();
        const text = runsText(runs).trim();
        if (!text) continue;
        budget.text(text.length);
        const target = sheet.cells.get(key(reference.row, reference.column));
        const cell = target || { row: reference.row, column: reference.column, runs: [], formula: null, css: {}, align: null, wrap: false, content: false };
        cell.comment = { text };
        if (!target) sheet.cells.set(key(reference.row, reference.column), cell);
      }
    }
    for (const relation of pkg.relatedByType(path, '/drawing')) {
      const drawingDoc = pkg.parse(relation.path);
      for (const anchor of elements(drawingDoc?.documentElement)) {
        if (!['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'].includes(anchor.localName)) continue;
        if (sheet.drawings.length >= MAX_DRAWINGS) throw pageLimit(`${label} exceeds the ${MAX_DRAWINGS} drawing limit.`);
        const marker = (name) => {
          const node = child(anchor, name);
          return node ? {
            row: Number(child(node, 'row')?.textContent) || 0, column: Number(child(node, 'col')?.textContent) || 0,
            dx: (Number(child(node, 'colOff')?.textContent) || 0) / EMU_PER_PX, dy: (Number(child(node, 'rowOff')?.textContent) || 0) / EMU_PER_PX,
          } : null;
        };
        const extent = child(anchor, 'ext');
        const position = child(anchor, 'pos');
        const placement = {
          from: marker('from'), to: anchor.localName === 'twoCellAnchor' ? marker('to') : null,
          width: (Number(val(extent, 'cx')) || 0) / EMU_PER_PX, height: (Number(val(extent, 'cy')) || 0) / EMU_PER_PX,
          ...(position ? { x: (Number(val(position, 'x')) || 0) / EMU_PER_PX, y: (Number(val(position, 'y')) || 0) / EMU_PER_PX } : {}),
        };
        let content = elements(anchor).find(item => ['pic', 'graphicFrame', 'sp', 'grpSp', 'cxnSp', 'AlternateContent'].includes(item.localName));
        if (content?.localName === 'AlternateContent') content = elements(child(content, 'Choice') || child(content, 'Fallback'))[0];
        if (!content) continue;
        const drawing = { placement, kind: 'object' };
        if (content.localName === 'pic') {
          const blip = descendant(content, 'blip');
          const target = pkg.related(relation.path, val(blip, 'embed') || val(blip, 'link'));
          const source = !target ? { format: 'unknown', limitation: 'unsupported-embedded-image-format' } : target.external ? { format: 'link', limitation: 'external-linked-image' } : imageSource(target.path);
          if (source.src) Object.assign(drawing, { kind: 'image', src: source.src });
          else { limitations.add(source.limitation, source.format); Object.assign(drawing, { kind: 'missing', label: `[Image not shown: ${source.format.toUpperCase()}]` }); }
        } else if (content.localName === 'sp' && descendant(content, 'txBody') && [...descendant(content, 'txBody').getElementsByTagNameNS('*', 't')].some(text => text.textContent.trim())) {
          const fill = resolveColor(child(child(content, 'spPr'), 'solidFill'), theme);
          const line = resolveColor(child(child(child(content, 'spPr'), 'ln'), 'solidFill'), theme);
          const paragraphs = childrenNamed(descendant(content, 'txBody'), 'p').map(paragraph => ({
            align: { ctr: 'center', r: 'right', just: 'justify' }[val(child(paragraph, 'pPr'), 'algn')] || 'left',
            runs: elements(paragraph).filter(item => ['r', 'fld', 'br'].includes(item.localName)).map((run) => {
              if (run.localName === 'br') return { text: '\n', css: {} };
              const properties = child(run, 'rPr');
              const css = {};
              if (Number(val(properties, 'sz')) > 0) css['font-size'] = `${Math.min(400, Number(val(properties, 'sz')) / 100)}pt`;
              if (val(properties, 'b') !== null) css['font-weight'] = isOn(properties, 'b') ? 'bold' : 'normal';
              if (val(properties, 'i') !== null) css['font-style'] = isOn(properties, 'i') ? 'italic' : 'normal';
              const color = colorCss(resolveColor(child(properties, 'solidFill'), theme));
              if (color) css.color = color;
              return { text: child(run, 't')?.textContent || '', css };
            }).filter(run => run.text),
          }));
          for (const paragraph of paragraphs) budget.text(runsText(paragraph.runs).length);
          Object.assign(drawing, { kind: 'text', paragraphs, fill: colorCss(fill), line: colorCss(line) });
        } else if (content.localName === 'graphicFrame') {
          const uri = val(descendant(content, 'graphicData'), 'uri') || '';
          const kind = /chart/i.test(uri) ? 'chart' : /diagram/i.test(uri) ? 'diagram' : 'object';
          limitations.add('unsupported-embedded-object', kind);
          Object.assign(drawing, { kind: 'missing', label: `[${kind === 'chart' ? 'Chart' : kind === 'diagram' ? 'Diagram' : 'Embedded object'} not shown]` });
        } else {
          limitations.add('unsupported-embedded-object', 'drawing');
          Object.assign(drawing, { kind: 'missing', label: '[Drawing not shown]' });
        }
        sheet.drawings.push(drawing);
      }
    }
    sheets.push(sheet);
  }
  return finishWorkbook({ label, sheets, hidden, limitations, baseCss: { 'font-family': "'Calibri', 'Carlito', sans-serif", 'font-size': '11pt', ...baseFont } });
};

// ---- ODS ----
const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  presentation: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
};
const PREFIX = new Map(Object.entries(NS).map(([prefix, uri]) => [uri, prefix]));
export const odfIs = (node, ns, ...names) => node?.nodeType === Node.ELEMENT_NODE && node.namespaceURI === NS[ns] && names.includes(node.localName);
export const odfAttr = (node, ns, name) => node?.getAttributeNS?.(NS[ns], name) ?? null;
const odfChildren = (node) => node ? [...node.childNodes].filter(item => item.nodeType === Node.ELEMENT_NODE) : [];
const odfAttributes = (node) => {
  const result = {};
  for (const attribute of node?.attributes || []) {
    const prefix = PREFIX.get(attribute.namespaceURI);
    if (prefix) result[`${prefix}:${attribute.localName}`] = attribute.value;
  }
  return result;
};
const GENERIC_FONTS = { roman: 'serif', swiss: 'sans-serif', modern: 'monospace', script: 'cursive', decorative: 'fantasy' };
// Styles of an OpenDocument file: content automatic styles over styles.xml, each
// following its parent chain over the family's default style.
export const createOdfStyles = (content, styles) => {
  const fonts = new Map();
  const named = new Map();
  const defaults = new Map();
  const lists = new Map();
  const masters = new Map();
  const pageLayouts = new Map();
  const sections = (doc, name) => doc ? odfChildren(doc.documentElement).filter(node => odfIs(node, 'office', name)) : [];
  for (const doc of [styles, content]) for (const decls of sections(doc, 'font-face-decls')) for (const face of odfChildren(decls)) {
    const family = odfAttr(face, 'svg', 'font-family')?.replace(/['"]/g, '');
    if (odfIs(face, 'style', 'font-face') && FONT_FAMILY.test(family || '')) fonts.set(odfAttr(face, 'style', 'name'), `'${family.replace(/,/g, '')}', ${GENERIC_FONTS[odfAttr(face, 'style', 'font-family-generic')] || 'sans-serif'}`);
  }
  const register = (node) => {
    if (odfIs(node, 'style', 'style')) named.set(`${odfAttr(node, 'style', 'family')}:${odfAttr(node, 'style', 'name')}`, node);
    else if (odfIs(node, 'style', 'default-style')) defaults.set(odfAttr(node, 'style', 'family'), node);
    else if (odfIs(node, 'text', 'list-style')) lists.set(odfAttr(node, 'style', 'name'), node);
    else if (odfIs(node, 'style', 'page-layout')) pageLayouts.set(odfAttr(node, 'style', 'name'), node);
  };
  for (const [doc, section] of [[styles, 'styles'], [styles, 'automatic-styles'], [content, 'automatic-styles']]) for (const part of sections(doc, section)) odfChildren(part).forEach(register);
  for (const part of sections(styles, 'master-styles')) for (const node of odfChildren(part)) if (odfIs(node, 'style', 'master-page')) masters.set(odfAttr(node, 'style', 'name'), node);
  const GROUPS = { cell: 'table-cell-properties', paragraph: 'paragraph-properties', text: 'text-properties', column: 'table-column-properties', row: 'table-row-properties', table: 'table-properties', graphic: 'graphic-properties', page: 'drawing-page-properties' };
  const read = (node) => {
    const result = {};
    for (const [group, name] of Object.entries(GROUPS)) result[group] = odfAttributes(odfChildren(node).find(item => odfIs(item, 'style', name)));
    result.listStyle = odfChildren(odfChildren(node).find(item => odfIs(item, 'style', 'graphic-properties'))).find(item => odfIs(item, 'text', 'list-style')) || null;
    return result;
  };
  const cache = new Map();
  const resolve = (family, name, depth = 0) => {
    const cacheKey = `${family}:${name}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const node = name ? named.get(cacheKey) : null;
    let resolved;
    if (!node || depth > 20) resolved = defaults.has(family) ? read(defaults.get(family)) : read(null);
    else {
      const parent = resolve(family, odfAttr(node, 'style', 'parent-style-name'), depth + 1);
      const own = read(node);
      resolved = Object.fromEntries(Object.keys(GROUPS).map(group => [group, { ...parent[group], ...own[group] }]));
      resolved.listStyle = own.listStyle || parent.listStyle;
    }
    cache.set(cacheKey, resolved);
    return resolved;
  };
  return { fonts, resolve, lists, masters, pageLayouts };
};
export const odfTextCss = (properties = {}, fonts = new Map()) => {
  const css = {};
  const size = properties['fo:font-size'];
  if (isLength(size) || /^\d+(?:\.\d+)?%$/.test(size || '')) css['font-size'] = size;
  if (/^(?:bold|normal|[1-9]00)$/.test(properties['fo:font-weight'] || '')) css['font-weight'] = properties['fo:font-weight'];
  if (/^(?:italic|normal|oblique)$/.test(properties['fo:font-style'] || '')) css['font-style'] = properties['fo:font-style'];
  const lines = [];
  if (properties['style:text-underline-style'] && properties['style:text-underline-style'] !== 'none') lines.push('underline');
  if (properties['style:text-line-through-style'] && properties['style:text-line-through-style'] !== 'none') lines.push('line-through');
  if (lines.length) css['text-decoration-line'] = lines.join(' ');
  if (isColor(properties['fo:color']) && properties['fo:color'] !== 'transparent') css.color = properties['fo:color'];
  if (/^(?:none|uppercase|lowercase|capitalize)$/.test(properties['fo:text-transform'] || '')) css['text-transform'] = properties['fo:text-transform'];
  const family = fonts.get(properties['style:font-name']) || fontStack(properties['fo:font-family']);
  if (family) css['font-family'] = family;
  const [position] = (properties['style:text-position'] || '').trim().split(/\s+/);
  if (position === 'super' || /^\d/.test(position || '') && parseFloat(position) > 0) Object.assign(css, { 'vertical-align': 'super', 'font-size': '58%' });
  else if (position === 'sub' || /^-\d/.test(position || '')) Object.assign(css, { 'vertical-align': 'sub', 'font-size': '58%' });
  return css;
};
const MAX_RENDERED_SPACES = 1000;
// Runs of an ODF paragraph: text spans with their style; spaces, tabs and line breaks kept.
export const odfRuns = (paragraph, styleSheet, baseCss = {}) => {
  const runs = [];
  const visit = (node, css) => {
    for (const item of node.childNodes) {
      if (item.nodeType === Node.TEXT_NODE || item.nodeType === Node.CDATA_SECTION_NODE) {
        const text = item.textContent.replace(/[\t\n\r ]+/g, ' ');
        if (text) runs.push({ text, css });
      } else if (item.nodeType === Node.ELEMENT_NODE) {
        if (odfIs(item, 'office', 'annotation', 'annotation-end') || odfIs(item, 'svg', 'title', 'desc') || odfIs(item, 'draw', 'frame', 'custom-shape', 'rect', 'ellipse', 'g', 'line')) continue;
        if (odfIs(item, 'text', 's')) {
          const count = Number(odfAttr(item, 'text', 'c') ?? 1);
          runs.push({ text: ' '.repeat(Number.isSafeInteger(count) && count > 0 ? Math.min(count, MAX_RENDERED_SPACES) : 1), css });
        } else if (odfIs(item, 'text', 'tab')) runs.push({ text: '\t', css });
        else if (odfIs(item, 'text', 'line-break')) runs.push({ text: '\n', css });
        else if (odfIs(item, 'text', 'span')) visit(item, { ...css, ...odfTextCss(styleSheet.resolve('text', odfAttr(item, 'text', 'style-name')).text, styleSheet.fonts) });
        else visit(item, css);
      }
    }
  };
  visit(paragraph, baseCss);
  return runs;
};

const odfBox = (properties = {}) => {
  const css = {};
  for (const side of ['', '-top', '-bottom', '-left', '-right']) if (BORDER.test(properties[`fo:border${side}`] || '')) css[`border${side}`] = properties[`fo:border${side}`];
  if (isColor(properties['fo:background-color'])) css['background-color'] = properties['fo:background-color'];
  return css;
};
const ODS_ALIGN = { start: 'left', left: 'left', end: 'right', right: 'right', center: 'center', justify: 'justify' };
export const readOdsWorkbook = ({ content, styles, entries, signal, sniffFormat, bitmapDimensions, bytesToBase64, maxPixels, maxText = Infinity }) => {
  const label = 'ODS';
  const spreadsheet = content.getElementsByTagNameNS(NS.office, 'spreadsheet')[0];
  if (!spreadsheet) throw new Error('Invalid ODS XML.');
  const styleSheet = createOdfStyles(content, styles);
  const budget = createBudget(label, maxText);
  const limitations = createLimitations();
  const hidden = { count: 0 };
  const imageSource = createImageSources({ entries, sniffFormat, bitmapDimensions, bytesToBase64, maxPixels });
  const cellStyles = new Map();
  const cellStyle = (name) => {
    if (!cellStyles.has(name)) {
      const resolved = styleSheet.resolve('table-cell', name);
      const css = { ...odfTextCss(resolved.text, styleSheet.fonts), ...odfBox(resolved.cell) };
      const vertical = resolved.cell['style:vertical-align'];
      css['vertical-align'] = vertical === 'top' ? 'top' : vertical === 'middle' ? 'middle' : 'bottom';
      const indent = toPx(resolved.paragraph['fo:margin-left']);
      if (indent > 0 && indent < 500) css['padding-left'] = `${Math.round(indent) + 3}px`;
      cellStyles.set(name, {
        css, wrap: resolved.cell['fo:wrap-option'] === 'wrap',
        align: resolved.cell['style:text-align-source'] === 'value-type' ? null : ODS_ALIGN[resolved.paragraph['fo:text-align']] || null,
        styled: Object.keys(odfBox(resolved.cell)).length > 0,
      });
    }
    return cellStyles.get(name);
  };
  const objectKind = (href) => {
    const data = entries[`${(href || '').replace(/^\.\//, '').replace(/\/$/, '')}/content.xml`];
    return data && /<chart:chart[\s>]/.test(new TextDecoder().decode(data.subarray(0, 65536))) ? 'chart' : 'object';
  };
  const drawingOf = (node, placement) => {
    const drawing = { placement, kind: 'object' };
    const width = toPx(odfAttr(node, 'svg', 'width'));
    const height = toPx(odfAttr(node, 'svg', 'height'));
    Object.assign(placement, { width, height });
    if (odfIs(node, 'draw', 'frame')) {
      const parts = odfChildren(node);
      const image = parts.find(part => odfIs(part, 'draw', 'image'));
      const object = parts.find(part => odfIs(part, 'draw', 'object', 'object-ole'));
      const textBox = parts.find(part => odfIs(part, 'draw', 'text-box'));
      if (object) {
        const kind = objectKind(odfAttr(object, 'xlink', 'href'));
        limitations.add('unsupported-embedded-object', kind);
        return Object.assign(drawing, { kind: 'missing', label: `[${kind === 'chart' ? 'Chart' : 'Embedded object'} not shown]` });
      }
      if (image) {
        const source = imageSource((odfAttr(image, 'xlink', 'href') || '').replace(/^\.\//, ''));
        if (source.src) return Object.assign(drawing, { kind: 'image', src: source.src });
        limitations.add(source.limitation, source.format);
        return Object.assign(drawing, { kind: 'missing', label: `[Image not shown: ${source.format.toUpperCase()}]` });
      }
      if (textBox) node = textBox;
    }
    const paragraphs = odfChildren(node).filter(item => odfIs(item, 'text', 'p', 'h'));
    if (paragraphs.some(paragraph => paragraph.textContent.trim())) {
      const graphic = styleSheet.resolve('graphic', odfAttr(node.parentNode && odfIs(node, 'draw', 'text-box') ? node.parentNode : node, 'draw', 'style-name')).graphic;
      const runs = paragraphs.map(paragraph => ({ align: 'left', runs: odfRuns(paragraph, styleSheet, odfTextCss(styleSheet.resolve('paragraph', odfAttr(paragraph, 'text', 'style-name')).text, styleSheet.fonts)) }));
      for (const paragraph of runs) budget.text(runsText(paragraph.runs).length);
      return Object.assign(drawing, {
        kind: 'text', paragraphs: runs,
        fill: graphic['draw:fill'] !== 'none' && isColor(graphic['draw:fill-color']) ? graphic['draw:fill-color'] : null,
        line: graphic['draw:stroke'] !== 'none' && isColor(graphic['svg:stroke-color']) ? graphic['svg:stroke-color'] : null,
      });
    }
    limitations.add('unsupported-embedded-object', 'drawing');
    return Object.assign(drawing, { kind: 'missing', label: '[Drawing not shown]' });
  };
  const DRAWINGS = ['frame', 'custom-shape', 'rect', 'ellipse', 'g'];
  const hasDrawing = (cell) => odfChildren(cell).some(item => odfIs(item, 'draw', ...DRAWINGS));
  const cellText = (cell) => odfChildren(cell).filter(item => odfIs(item, 'text', 'p', 'h')).map(paragraph => paragraph.textContent).join('');

  const sheets = [];
  for (const [sheetIndex, table] of odfChildren(spreadsheet).filter(node => odfIs(node, 'table', 'table')).entries()) {
    signal?.throwIfAborted();
    const sheetHidden = styleSheet.resolve('table', odfAttr(table, 'table', 'style-name')).table['table:display'] === 'false';
    const columns = [];
    let columnIndex = 0;
    const visitColumns = (node) => {
      for (const item of odfChildren(node)) {
        if (odfIs(item, 'table', 'table-column')) {
          const repeat = Math.max(1, Math.min(MAX_COLUMN, Number(odfAttr(item, 'table', 'number-columns-repeated')) || 1));
          const width = toPx(styleSheet.resolve('table-column', odfAttr(item, 'table', 'style-name')).column['style:column-width'], 85);
          const visibility = odfAttr(item, 'table', 'visibility');
          columns.push({ min: columnIndex, max: Math.min(MAX_COLUMN, columnIndex + repeat) - 1, width, hidden: visibility === 'collapse' || visibility === 'filter',
            defaultStyle: odfAttr(item, 'table', 'default-cell-style-name') });
          columnIndex += repeat;
          if (columnIndex >= MAX_COLUMN) return;
        } else if (odfIs(item, 'table', 'table-column-group', 'table-header-columns', 'table-columns')) visitColumns(item);
      }
    };
    visitColumns(table);
    const columnAt = (index) => columns.find(column => index >= column.min && index <= column.max) || null;
    const sheet = { name: odfAttr(table, 'table', 'name') || `Sheet${sheetIndex + 1}`, cells: new Map(), rows: new Map(), columns, defaultWidth: 85, defaultHeight: 17, merges: [], drawings: [], styled: 0 };
    let rowIndex = 0;
    const addCell = (row, column, cellNode, style, valueType) => {
      const paragraphs = odfChildren(cellNode).filter(item => odfIs(item, 'text', 'p', 'h'));
      const runs = [];
      paragraphs.forEach((paragraph, index) => {
        if (index) runs.push({ text: '\n', css: {} });
        runs.push(...odfRuns(paragraph, styleSheet, odfTextCss(styleSheet.resolve('paragraph', odfAttr(paragraph, 'text', 'style-name')).text, styleSheet.fonts)));
      });
      if (!runs.some(run => run.text.trim())) {
        const value = odfAttr(cellNode, 'office', 'string-value') ?? odfAttr(cellNode, 'office', 'value') ?? odfAttr(cellNode, 'office', 'date-value') ?? odfAttr(cellNode, 'office', 'time-value') ?? odfAttr(cellNode, 'office', 'boolean-value');
        runs.splice(0, runs.length, ...(value ? [{ text: valueType === 'boolean' ? (value === 'true' ? 'TRUE' : 'FALSE') : value, css: {} }] : []));
      }
      const formula = odfAttr(cellNode, 'table', 'formula') ? odsFormula(odfAttr(cellNode, 'table', 'formula')) : null;
      const comment = odfChildren(cellNode).find(item => odfIs(item, 'office', 'annotation'));
      const commentText = comment ? odfChildren(comment).filter(item => odfIs(item, 'text', 'p', 'h', 'list')).map(item => item.textContent).join('\n').trim() : '';
      budget.cell();
      budget.text(runsText(runs).length + (formula?.length || 0) + commentText.length);
      sheet.cells.set(key(row, column), {
        row, column, runs, formula, css: style.css, align: style.align, wrap: style.wrap, content: runs.some(run => run.text.trim()) || !!formula,
        kind: ['float', 'percentage', 'currency', 'date', 'time'].includes(valueType) ? 'number' : valueType === 'boolean' ? 'logical' : 'text',
        ...(commentText ? { comment: { text: commentText } } : {}),
      });
      for (const drawingNode of odfChildren(cellNode).filter(item => odfIs(item, 'draw', ...DRAWINGS))) {
        if (sheet.drawings.length >= MAX_DRAWINGS) throw pageLimit(`${label} exceeds the ${MAX_DRAWINGS} drawing limit.`);
        // A shape stored in a cell is anchored there; svg:x and svg:y are its offset in that cell.
        sheet.drawings.push(drawingOf(drawingNode, { from: { row, column, dx: Math.max(0, toPx(odfAttr(drawingNode, 'svg', 'x'))), dy: Math.max(0, toPx(odfAttr(drawingNode, 'svg', 'y'))) } }));
      }
    };
    const visitRows = (node) => {
      for (const row of odfChildren(node)) {
        signal?.throwIfAborted();
        if (rowIndex >= MAX_ROW) return;
        if (odfIs(row, 'table', 'table-row-group', 'table-header-rows', 'table-rows')) { visitRows(row); continue; }
        if (odfIs(row, 'table', 'shapes')) {
          for (const drawingNode of odfChildren(row).filter(item => odfIs(item, 'draw', ...DRAWINGS))) {
            if (sheet.drawings.length >= MAX_DRAWINGS) throw pageLimit(`${label} exceeds the ${MAX_DRAWINGS} drawing limit.`);
            if (!sheetHidden) sheet.drawings.push(drawingOf(drawingNode, { x: toPx(odfAttr(drawingNode, 'svg', 'x')), y: toPx(odfAttr(drawingNode, 'svg', 'y')) }));
          }
          continue;
        }
        if (!odfIs(row, 'table', 'table-row')) continue;
        const repeat = Math.max(1, Math.min(MAX_ROW - rowIndex, Number(odfAttr(row, 'table', 'number-rows-repeated')) || 1));
        const visibility = odfAttr(row, 'table', 'visibility');
        const rowHidden = visibility === 'collapse' || visibility === 'filter';
        const height = toPx(styleSheet.resolve('table-row', odfAttr(row, 'table', 'style-name')).row['style:row-height']);
        // Cells with their columns; empty repeated cells only move the column on.
        const cells = [];
        let column = 0;
        for (const cell of odfChildren(row)) {
          if (!odfIs(cell, 'table', 'table-cell', 'covered-table-cell') || column >= MAX_COLUMN) continue;
          const columnRepeat = Math.max(1, Math.min(MAX_COLUMN - column, Number(odfAttr(cell, 'table', 'number-columns-repeated')) || 1));
          const content = odfIs(cell, 'table', 'table-cell') && (!!cellText(cell).trim() || !!odfAttr(cell, 'table', 'formula') || odfChildren(cell).some(item => odfIs(item, 'office', 'annotation')) || hasDrawing(cell));
          cells.push({ node: cell, column, repeat: columnRepeat, content, covered: odfIs(cell, 'table', 'covered-table-cell') });
          column += columnRepeat;
        }
        const contentCells = cells.filter(cell => cell.content).reduce((sum, cell) => sum + cell.repeat, 0);
        if (!contentCells) {
          // Styled empty cells (fills and borders) are kept only in small blocks: whole formatted rows repeat thousands of times.
          if (repeat <= 100 && !sheetHidden) for (const cell of cells) {
            if (cell.covered || cell.repeat > 100) continue;
            const style = cellStyle(odfAttr(cell.node, 'table', 'style-name') || odfAttr(row, 'table', 'default-cell-style-name') || columnAt(cell.column)?.defaultStyle || 'Default');
            if (!style.styled) continue;
            for (let r = 0; r < repeat; r++) for (let c = 0; c < cell.repeat && sheet.styled < MAX_STYLED_CELLS; c++, sheet.styled++) {
              sheet.cells.set(key(rowIndex + r, cell.column + c), { row: rowIndex + r, column: cell.column + c, runs: [], formula: null, css: style.css, align: null, wrap: false, content: false });
            }
          }
          if (rowHidden || height) for (let r = 0; r < Math.min(repeat, 1000); r++) sheet.rows.set(rowIndex + r, { hidden: rowHidden, height: height || null });
          rowIndex += repeat;
          continue;
        }
        if (repeat * contentCells > MAX_SHEET_CELLS) throw pageLimit(`${label} exceeds the 10,000 non-empty cell limit.`);
        for (let r = 0; r < repeat; r++) {
          const current = rowIndex + r;
          if (rowHidden || height) sheet.rows.set(current, { hidden: rowHidden, height: height || null });
          for (const cell of cells) {
            if (cell.covered) continue;
            const columnHidden = (index) => columnAt(index)?.hidden;
            for (let c = 0; c < cell.repeat; c++) {
              const index = cell.column + c;
              if (!cell.content) continue;
              if (sheetHidden || rowHidden || columnHidden(index)) { hidden.count++; continue; }
              const style = cellStyle(odfAttr(cell.node, 'table', 'style-name') || odfAttr(row, 'table', 'default-cell-style-name') || columnAt(index)?.defaultStyle || 'Default');
              addCell(current, index, cell.node, style, odfAttr(cell.node, 'office', 'value-type'));
              const columnSpan = Number(odfAttr(cell.node, 'table', 'number-columns-spanned')) || 1;
              const rowSpan = Number(odfAttr(cell.node, 'table', 'number-rows-spanned')) || 1;
              if (columnSpan > 1 || rowSpan > 1) sheet.merges.push({ r1: current, c1: index, r2: Math.min(MAX_ROW - 1, current + rowSpan - 1), c2: Math.min(MAX_COLUMN - 1, index + columnSpan - 1) });
            }
          }
        }
        rowIndex += repeat;
      }
    };
    visitRows(table);
    if (!sheetHidden) sheets.push(sheet);
  }
  const defaults = styleSheet.resolve('table-cell', 'Default');
  return finishWorkbook({ label, sheets, hidden, limitations,
    baseCss: { 'font-family': "'Liberation Sans', Arial, sans-serif", 'font-size': '10pt', ...odfTextCss(defaults.text, styleSheet.fonts) } });
};

// Hidden rows and columns are left out of the pages and the text; their cells are counted.
const finishWorkbook = ({ label, sheets, hidden, limitations, baseCss }) => {
  for (const sheet of sheets) {
    sheet.columnInfo = (index) => {
      const column = sheet.columns.find(item => index >= item.min && index <= item.max);
      return { width: column?.width ?? sheet.defaultWidth, hidden: !!column?.hidden };
    };
    sheet.rowInfo = (index) => ({ height: sheet.rows.get(index)?.height || sheet.defaultHeight, hidden: !!sheet.rows.get(index)?.hidden });
    for (const [cellKey, cell] of sheet.cells) {
      if (!sheet.rowInfo(cell.row).hidden && !sheet.columnInfo(cell.column).hidden) continue;
      if (cell.content || cell.comment) hidden.count++;
      sheet.cells.delete(cellKey);
    }
    sheet.merges = sheet.merges.filter(merge => (merge.r2 - merge.r1 + 1) * (merge.c2 - merge.c1 + 1) <= MAX_MERGE_CELLS && sheet.cells.get(key(merge.r1, merge.c1))?.content);
  }
  return { label, sheets, hidden, limitations, baseCss };
};

// ---- Layout ----
// Column positions in pixels, hidden columns and rows taking no space.
const geometry = (sheet) => {
  const columnLefts = [0];
  const rowTops = [0];
  const columnLeft = (index) => {
    while (columnLefts.length <= index && columnLefts.length <= MAX_COLUMN) {
      const previous = columnLefts.length - 1;
      const info = sheet.columnInfo(previous);
      columnLefts.push(columnLefts[previous] + (info.hidden ? 0 : info.width));
    }
    return columnLefts[Math.min(index, columnLefts.length - 1)];
  };
  const rowTop = (index) => {
    while (rowTops.length <= index && rowTops.length <= MAX_ROW) {
      const previous = rowTops.length - 1;
      const info = sheet.rowInfo(previous);
      rowTops.push(rowTops[previous] + (info.hidden ? 0 : info.height));
    }
    return rowTops[Math.min(index, rowTops.length - 1)];
  };
  // An absolute position (ODS shapes, XLSX absolute anchors) to the cell that holds it.
  const search = (position, limit, start) => {
    let low = 0;
    let high = Math.min(limit, MAX_ROW);
    start(high);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (start(middle) <= position) low = middle; else high = middle - 1;
    }
    return low;
  };
  const locate = (x, y, limitRow, limitColumn) => {
    const column = search(x, Math.min(limitColumn, MAX_COLUMN - 1), columnLeft);
    const row = search(y, Math.min(limitRow, MAX_ROW - 1), rowTop);
    return { row, column, dx: x - columnLeft(column), dy: y - rowTop(row) };
  };
  return { columnLeft, rowTop, locate };
};

const sheetLayout = (sheet) => {
  const content = [...sheet.cells.values()].filter(cell => cell.content || cell.comment);
  let maxRow = -1;
  let maxColumn = -1;
  for (const cell of content) { maxRow = Math.max(maxRow, cell.row); maxColumn = Math.max(maxColumn, cell.column); }
  const space = geometry(sheet);
  const boundRow = Math.max(maxRow, 0) + 200;
  const boundColumn = Math.max(maxColumn, 0) + 50;
  for (const drawing of sheet.drawings) {
    const placement = drawing.placement;
    // Absolute positions (XLSX absolute anchors, ODS shapes anchored to the sheet) become the cell under them.
    if (placement.x !== undefined && placement.y !== undefined) placement.from = space.locate(placement.x, placement.y, boundRow, boundColumn);
    const from = placement.from || { row: 0, column: 0, dx: 0, dy: 0 };
    if (placement.to) {
      placement.width = Math.max(1, space.columnLeft(placement.to.column) + placement.to.dx - space.columnLeft(from.column) - from.dx);
      placement.height = Math.max(1, space.rowTop(placement.to.row) + placement.to.dy - space.rowTop(from.row) - from.dy);
    } else {
      const end = space.locate(space.columnLeft(from.column) + from.dx + placement.width, space.rowTop(from.row) + from.dy + placement.height, from.row + 200, from.column + 50);
      placement.to = end;
    }
    placement.width = Math.min(placement.width || 100, 4000);
    placement.height = Math.min(placement.height || 60, 4000);
    maxRow = Math.max(maxRow, from.row, Math.min(placement.to.row, from.row + 200));
    maxColumn = Math.max(maxColumn, from.column, Math.min(placement.to.column, from.column + 50));
  }
  for (const merge of sheet.merges) { maxRow = Math.max(maxRow, merge.r2); maxColumn = Math.max(maxColumn, merge.c2); }
  if (maxRow < 0) return null;
  const occupiedRows = new Set();
  const occupiedColumns = new Set();
  for (const cell of content) { occupiedRows.add(cell.row); occupiedColumns.add(cell.column); }
  for (const merge of sheet.merges) {
    for (let row = merge.r1; row <= merge.r2; row++) occupiedRows.add(row);
    for (let column = merge.c1; column <= merge.c2; column++) occupiedColumns.add(column);
  }
  for (const { placement } of sheet.drawings) {
    for (let row = placement.from.row; row <= Math.min(placement.to.row, placement.from.row + 200); row++) occupiedRows.add(row);
    for (let column = placement.from.column; column <= Math.min(placement.to.column, placement.from.column + 50); column++) occupiedColumns.add(column);
  }
  const entries = (last, hiddenAt, occupied, run, make) => {
    const list = [];
    let empty = [];
    const flush = () => {
      if (empty.length > run) list.push({ gap: [empty[0], empty.at(-1)] }); else list.push(...empty.map(make));
      empty = [];
    };
    for (let index = 0; index <= last; index++) {
      if (hiddenAt(index)) continue;
      if (occupied.has(index)) { flush(); list.push(make(index)); } else empty.push(index);
    }
    flush();
    return list;
  };
  const rows = entries(maxRow, index => sheet.rowInfo(index).hidden, occupiedRows, EMPTY_ROW_RUN, row => ({ row }));
  const columns = entries(maxColumn, index => sheet.columnInfo(index).hidden, occupiedColumns, EMPTY_COLUMN_RUN, column => ({ column, width: Math.min(CONTENT_WIDTH, Math.max(8, sheet.columnInfo(column).width)) }));
  for (const column of columns) if (column.gap) column.width = GAP_WIDTH;
  const bands = [];
  let width = Infinity;
  for (const column of columns) {
    if (width + column.width > CONTENT_WIDTH) { bands.push([]); width = 0; }
    bands.at(-1).push(column);
    width += column.width;
  }
  return { rows, bands, space };
};

// Per page text: "[Sheet: name]" and each row's non-empty cells as "A1: value", tab separated.
const describe = (entry, invisible, counter) => {
  const { cell, merge } = entry;
  let text = '';
  let hiddenRuns = false;
  for (const run of cell.runs) {
    if (invisible?.has(run)) { if (run.text.trim()) hiddenRuns = true; continue; }
    text += run.text;
  }
  if (hiddenRuns) counter.count++;
  const reference = cellReference(cell.row, cell.column);
  const label = merge ? `${reference} (merged ${reference}:${cellReference(merge.r2, merge.c2)})` : reference;
  if (hiddenRuns && !text.trim()) return null;
  if (!text.trim() && !cell.formula) return null;
  const value = text.replace(/\r?\n/g, ' / ').trim();
  return `${label}: ${value}${cell.formula ? `${value ? ' ' : ''}(${cell.formula})` : ''}`;
};
const pieceText = (source, invisible, counter) => {
  const lines = [];
  for (const row of source.cells) {
    const parts = row.map(entry => describe(entry, invisible, counter)).filter(Boolean);
    if (parts.length) lines.push(parts.join('\t'));
  }
  for (const { cell, comment } of source.comments) {
    if (invisible?.has(comment)) { counter.count++; continue; }
    lines.push(`[Comment ${cellReference(cell.row, cell.column)}: ${comment.text.replace(/\r?\n/g, ' / ')}]`);
  }
  for (const { reference, drawing } of source.textBoxes) {
    const paragraphs = drawing.paragraphs.map((paragraph) => {
      let text = '';
      for (const run of paragraph.runs) {
        if (invisible?.has(run)) { if (run.text.trim()) counter.count++; continue; }
        text += run.text;
      }
      return text;
    }).filter(text => text.trim());
    if (paragraphs.length) lines.push(`[Text box at ${reference}]\n${paragraphs.join('\n')}`);
  }
  return lines;
};
const heading = (source) => `[Sheet: ${source.sheet.name}${source.bands > 1 ? `, columns ${source.columnRange}` : ''}]`;
export const workbookPageTexts = (workbook, pages) => {
  const counter = { count: 0 };
  const pageTexts = pages.map((page) => {
    const lines = [];
    let current = null;
    for (const source of page.sources) {
      if (!current || source.sheet !== current.sheet || source.band !== current.band) {
        lines.push(heading(source));
        current = source;
      }
      if (source.empty) { lines.push('(empty sheet)'); continue; }
      lines.push(...pieceText(source, pages.invisibleSources, counter));
    }
    return lines;
  });
  return { pageTexts, invisibleCount: counter.count };
};
// Text without page images (rendering failed): every visible sheet, all columns.
export const workbookText = (workbook) => workbook.sheets.map((sheet) => {
  const rows = new Map();
  for (const cell of sheet.cells.values()) if (cell.content || cell.comment) (rows.get(cell.row) || rows.set(cell.row, []).get(cell.row)).push(cell);
  const merges = new Map(sheet.merges.map(merge => [key(merge.r1, merge.c1), merge]));
  const source = { cells: [], comments: [], textBoxes: [] };
  for (const row of [...rows.keys()].sort((a, b) => a - b)) {
    const cells = rows.get(row).sort((a, b) => a.column - b.column);
    source.cells.push(cells.filter(cell => cell.content).map(cell => ({ cell, merge: merges.get(key(cell.row, cell.column)) })));
    source.comments.push(...cells.filter(cell => cell.comment).map(cell => ({ cell, comment: cell.comment })));
  }
  return [`[Sheet: ${sheet.name}]`, ...(source.cells.length || source.comments.length ? pieceText(source, null, { count: 0 }) : ['(empty sheet)'])].join('\n');
}).join('\n\n');

const HEADING_CSS = { 'background-color': '#f2f2f2', color: '#444444', border: '0.75pt solid #bfbfbf', 'font-family': 'Arial, sans-serif', 'font-size': '8pt', 'font-weight': 'normal', 'font-style': 'normal', 'text-align': 'center', 'vertical-align': 'middle', padding: '0 2px', 'white-space': 'nowrap', overflow: 'hidden' };
const GRID_CSS = { border: '0.75pt solid #d9d9d9', padding: '1px 3px', 'vertical-align': 'bottom', 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere', overflow: 'hidden' };
const renderWorkbookPages = async ({ workbook, signal, encodePageImage, maxImageCharacters, pageImages, redact }) => {
  const { label } = workbook;
  const sourceOf = new WeakMap();
  const pendingImages = [];
  let elementCount = 0;
  const countElements = (amount) => {
    elementCount += amount;
    if (elementCount > MAX_TABLE_ELEMENTS) throw pageLimit(`${label} tables exceed the 200,000 element limit.`);
  };
  const styles = new Map();
  const pieces = [];
  for (const [sheetIndex, sheet] of workbook.sheets.entries()) {
    signal?.throwIfAborted();
    const layout = sheetLayout(sheet);
    if (!layout) {
      const name = `${sheetIndex}:empty`;
      styles.set(name, { sheet, title: sheet.name });
      const element = applyCss(html('p'), { color: '#555555', 'font-style': 'italic' });
      element.textContent = '(empty sheet)';
      pieces.push({ element, source: { sheet, band: 0, bands: 1, empty: true }, master: name });
      continue;
    }
    const { rows, bands, space } = layout;
    const estimate = bands.reduce((sum, band) => sum + rows.length * (band.length + 1), 0);
    if (estimate + elementCount > MAX_TABLE_ELEMENTS) throw pageLimit(`${label} tables exceed the 200,000 element limit.`);
    const mergeAt = new Map();
    for (const merge of sheet.merges) for (let row = merge.r1; row <= merge.r2; row++) for (let column = merge.c1; column <= merge.c2; column++) mergeAt.set(key(row, column), merge);
    // Rows joined by a vertical merge stay on one page so the merged cell is drawn whole.
    const visibleRows = rows.filter(entry => entry.row !== undefined).map(entry => entry.row);
    const spannable = new Set(sheet.merges.filter(merge => merge.r2 > merge.r1 && visibleRows.filter(row => row >= merge.r1 && row <= merge.r2).length <= MAX_SPANNED_ROWS));
    const joinedAfter = new Map();
    for (const merge of spannable) for (let row = merge.r1; row < merge.r2; row++) joinedAfter.set(row, Math.max(joinedAfter.get(row) ?? -1, merge.r2));
    const clusters = [];
    let open = -1;
    for (const entry of rows) {
      if (entry.row !== undefined && open >= entry.row && clusters.length) clusters.at(-1).push(entry);
      else clusters.push([entry]);
      open = entry.row !== undefined ? Math.max(open >= entry.row ? open : -1, joinedAfter.get(entry.row) ?? -1) : -1;
    }
    const drawingsAt = new Map();
    for (const drawing of sheet.drawings) {
      const anchor = key(drawing.placement.from.row, drawing.placement.from.column);
      (drawingsAt.get(anchor) || drawingsAt.set(anchor, []).get(anchor)).push(drawing);
    }
    bands.forEach((band, bandIndex) => {
      const columnsInBand = band.filter(entry => entry.column !== undefined);
      const columnRange = `${columnName(band[0].column ?? band[0].gap[0])}–${columnName(band.at(-1).column ?? band.at(-1).gap[1])}`;
      const styleName = `${sheetIndex}:${bandIndex}`;
      styles.set(styleName, { sheet, title: bands.length > 1 ? `${sheet.name} · columns ${columnRange}` : sheet.name });
      const tableWidth = HEADER_WIDTH + band.reduce((sum, entry) => sum + entry.width, 0);
      const headerRow = html('tr');
      headerRow.append(applyCss(html('th'), { ...HEADING_CSS, width: `${HEADER_WIDTH}px` }));
      for (const entry of band) {
        const cell = applyCss(html('th'), HEADING_CSS);
        cell.textContent = entry.gap ? `${columnName(entry.gap[0])}–${columnName(entry.gap[1])}` : columnName(entry.column);
        headerRow.append(cell);
      }
      const head = html('thead');
      head.append(headerRow);
      const group = {
        create: () => {
          const element = applyCss(html('table'), { 'table-layout': 'fixed', width: `${tableWidth}px`, 'border-collapse': 'collapse', ...workbook.baseCss, 'line-height': '1.2' });
          const columnGroup = html('colgroup');
          columnGroup.append(applyCss(html('col'), { width: `${HEADER_WIDTH}px` }), ...band.map(entry => applyCss(html('col'), { width: `${entry.width}px` })));
          element.append(columnGroup, head.cloneNode(true));
          countElements(band.length + 4);
          const target = html('tbody');
          element.append(target);
          return { element, target };
        },
      };
      const firstVisible = (from, to) => visibleRows.find(row => row >= from && row <= to);
      const columnsWithin = (merge) => band.filter(entry => entry.column !== undefined && entry.column >= merge.c1 && entry.column <= merge.c2);
      clusters.forEach((cluster, clusterIndex) => {
        const source = { sheet, band: bandIndex, bands: bands.length, columnRange, cells: [], comments: [], textBoxes: [] };
        const notes = [];
        const rowElements = cluster.map((entry) => {
          const tr = html('tr');
          if (entry.gap) {
            const number = applyCss(html('th'), HEADING_CSS);
            number.textContent = '⋯';
            const cell = applyCss(html('td'), { ...GRID_CSS, color: '#666666', 'font-style': 'italic', 'font-size': '8pt', 'text-align': 'center' });
            cell.colSpan = band.length;
            cell.textContent = `Rows ${entry.gap[0] + 1}–${entry.gap[1] + 1} are empty`;
            tr.append(number, cell);
            countElements(3);
            return tr;
          }
          const { row } = entry;
          applyCss(tr, { height: `${Math.max(12, Math.min(800, sheet.rowInfo(row).height))}px` });
          const number = applyCss(html('th'), { ...HEADING_CSS, position: 'relative', overflow: 'visible' });
          number.textContent = String(row + 1);
          tr.append(number);
          const rowCells = [];
          for (let index = 0; index < band.length; index++) {
            const column = band[index];
            if (column.gap) { tr.append(applyCss(html('td'), GRID_CSS)); continue; }
            const merge = mergeAt.get(key(row, column.column));
            let cell = sheet.cells.get(key(row, column.column));
            const td = applyCss(html('td'), GRID_CSS);
            let showContent = true;
            if (merge) {
              const spans = spannable.has(merge) && cluster.some(item => item.row === merge.r1 || item.row === firstVisible(merge.r1, merge.r2));
              const top = spans ? firstVisible(merge.r1, merge.r2) : row;
              const inside = columnsWithin(merge);
              if (row !== top || inside[0] !== column) continue;
              td.colSpan = inside.length;
              if (spans) td.rowSpan = visibleRows.filter(item => item >= merge.r1 && item <= merge.r2).length;
              index += inside.length - 1;
              cell = sheet.cells.get(key(merge.r1, merge.c1));
              showContent = column.column === merge.c1 && (spans || row === firstVisible(merge.r1, merge.r2));
            }
            if (cell) {
              applyCss(td, cell.css);
              const numeric = cell.kind === 'number';
              td.style.textAlign = cell.align || (numeric ? 'right' : cell.kind === 'logical' ? 'center' : 'left');
              if (showContent && cell.content) {
                for (const run of cell.runs) {
                  const span = applyCss(html('span'), run.css);
                  span.append(mappedText(run.text, run, sourceOf));
                  td.append(span);
                }
                rowCells.push({ cell, merge: merge && showContent ? merge : null });
                // Text longer than its column runs over the empty cells to its right, as in the spreadsheet.
                if (!merge && !cell.wrap && cell.kind === 'text' && (!cell.align || cell.align === 'left')) {
                  const fontSize = parseFloat(cell.css['font-size'] || workbook.baseCss['font-size']) || 11;
                  let needed = runsText(cell.runs).split('\n').reduce((longest, line) => Math.max(longest, line.length), 0) * fontSize * 0.75 - column.width;
                  while (needed > 0 && index + 1 < band.length) {
                    const next = band[index + 1];
                    if (next.gap || mergeAt.has(key(row, next.column)) || sheet.cells.get(key(row, next.column))?.content || sheet.cells.get(key(row, next.column))?.comment) break;
                    td.colSpan += 1;
                    index++;
                    needed -= next.width;
                  }
                }
              }
              if (showContent && cell.comment) {
                const comment = cell.comment;
                td.style.position = 'relative';
                td.append(applyCss(html('span'), { position: 'absolute', top: '0', right: '0', width: '0', height: '0', 'border-top': '6px solid #d00000', 'border-left': '6px solid transparent' }));
                const note = applyCss(html('p'), { 'font-size': '8pt', 'font-family': 'Arial, sans-serif' });
                const strong = html('b');
                strong.textContent = `${cellReference(cell.row, cell.column)}: `;
                note.append(strong, mappedText(comment.text, comment, sourceOf));
                notes.push(note);
                source.comments.push({ cell, comment });
              }
            }
            tr.append(td);
          }
          // Images, charts and text boxes are drawn over the cells from the row that anchors them.
          for (const column of columnsInBand) {
            for (const drawing of drawingsAt.get(key(row, column.column)) || []) {
              const { placement } = drawing;
              const left = HEADER_WIDTH + band.slice(0, band.indexOf(column)).reduce((sum, item) => sum + item.width, 0) + placement.from.dx;
              const box = applyCss(html('div'), { position: 'absolute', left: `${left}px`, top: `${placement.from.dy}px`, width: `${placement.width}px`, height: `${placement.height}px`, 'z-index': '2', 'text-align': 'left', 'font-size': '11pt', 'font-family': 'inherit', color: '#000000', 'white-space': 'pre-wrap' });
              box.dataset.visual = 'drawing';
              if (drawing.kind === 'image') {
                const image = applyCss(html('img'), { width: '100%', height: '100%', 'object-fit': 'fill', 'max-width': 'none' });
                image.src = drawing.src;
                pendingImages.push(imageLoaded(image));
                box.append(image);
              } else if (drawing.kind === 'text') {
                applyCss(box, { 'background-color': drawing.fill || 'transparent', border: drawing.line ? `0.75pt solid ${drawing.line}` : 'none', padding: '4px 8px', 'box-sizing': 'border-box', overflow: 'visible' });
                for (const paragraph of drawing.paragraphs) {
                  const element = applyCss(html('p'), { 'text-align': paragraph.align });
                  for (const run of paragraph.runs) {
                    const span = applyCss(html('span'), run.css);
                    span.append(mappedText(run.text, run, sourceOf));
                    element.append(span);
                  }
                  box.append(element);
                }
                source.textBoxes.push({ reference: cellReference(row, column.column), drawing });
              } else box.append(placeholder(drawing.label, '100%', '100%'));
              number.append(box);
            }
          }
          source.cells.push(rowCells);
          countElements(tr.getElementsByTagName('*').length + 1);
          return tr;
        });
        pieces.push({
          element: rowElements.length === 1 ? rowElements[0] : rowElements, group, notes, source: { ...source, rows: cluster.map(entry => entry.row).filter(row => row !== undefined) },
          ...(clusterIndex === 0 ? { master: styleName } : {}),
        });
      });
    });
  }
  const createPage = (style) => {
    const root = applyCss(html('div', 'doc-page'), {
      width: `${PAGE_WIDTH_MM}mm`, height: `${PAGE_HEIGHT_MM}mm`, padding: `${PAGE_MARGIN_MM}mm`, ...workbook.baseCss, 'line-height': '1.2',
    });
    const header = applyCss(html('div', 'doc-header'), { 'font-family': 'Arial, sans-serif', 'font-size': '9pt', color: '#444444', 'margin-bottom': '4px' });
    const title = html('p');
    title.textContent = style.title;
    header.append(title);
    const page = { root, header, body: html('div', 'doc-body'), notes: html('div', 'doc-notes') };
    root.append(page.header, page.body, page.notes);
    return page;
  };
  const first = styles.values().next().value;
  const pages = await paginateAndRender({
    pieces, useSoftBreaks: false, label, signal, encodePageImage, maxImageCharacters, pendingImages, sourceOf, pageImages, redact,
    firstStyle: first, styleByName: (name) => styles.get(name) || null, nextStyle: (style) => style, createPage,
  });
  return { pages, imageLimitations: workbook.limitations.list(), invisibleSources: pages.invisibleSources };
};

export const renderXlsxPages = (options) => renderWorkbookPages(options);
export const renderOdsPages = (options) => renderWorkbookPages(options);
