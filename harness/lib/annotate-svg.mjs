const COLORS = {
  blue: '#3182F6',
  red: '#F04452',
  gray: '#4E5968',
};

const COVER_FILL = '#E5E8EB';
const COVER_STROKE = '#D1D6DB';
const FONT_FAMILY = "-apple-system, 'Apple SD Gothic Neo', 'Pretendard', 'Noto Sans KR', 'Malgun Gothic', sans-serif";
const LABEL_FONT_SIZE = 14;
const LABEL_HEIGHT = 28;
const LABEL_PADDING = 12;
const BADGE_RADIUS = 14;

function escapeXml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function annotationColor(name) {
  return COLORS[name ?? 'blue'];
}

function textWidth(text) {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code <= 0x7f) width += code === 0x20 ? 5 : 8.5;
    else width += LABEL_FONT_SIZE;
  }
  return Math.ceil(width);
}

function labelPill(x, y, text, color) {
  const width = textWidth(text) + LABEL_PADDING * 2;
  const fill = annotationColor(color);
  const textX = x + LABEL_PADDING;
  const textY = y + LABEL_HEIGHT / 2 + LABEL_FONT_SIZE * 0.36;
  return [
    `<rect x="${x}" y="${y}" width="${width}" height="${LABEL_HEIGHT}" rx="${LABEL_HEIGHT / 2}" ` +
      `fill="${fill}" stroke="#FFFFFF" stroke-width="1.5"/>`,
    `<text x="${textX}" y="${textY}" font-family="${escapeXml(FONT_FAMILY)}" ` +
      `font-size="${LABEL_FONT_SIZE}" font-weight="600" fill="#FFFFFF">${escapeXml(text)}</text>`,
  ].join('');
}

function badgeCircle(x, y, number, color) {
  const fill = annotationColor(color);
  return [
    `<circle cx="${x}" cy="${y}" r="${BADGE_RADIUS}" fill="${fill}" stroke="#FFFFFF" stroke-width="2"/>`,
    `<text x="${x}" y="${y + 5.5}" text-anchor="middle" font-family="${escapeXml(FONT_FAMILY)}" ` +
      `font-size="15" font-weight="700" fill="#FFFFFF">${number}</text>`,
  ].join('');
}

function boxShape(annotation) {
  const [x, y, width, height] = annotation.rect;
  const color = annotationColor(annotation.color);
  const parts = [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="none" ` +
      `stroke="#FFFFFF" stroke-width="5.5"/>`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="none" ` +
      `stroke="${color}" stroke-width="2.75"/>`,
  ];
  if (annotation.label) {
    const position = annotation.labelPosition ??
      (y >= LABEL_HEIGHT + 16 ? 'above' : 'below');
    const labelY = position === 'above'
      ? Math.max(y - LABEL_HEIGHT - 10, 2)
      : y + height + 10;
    parts.push(labelPill(x, labelY, annotation.label, annotation.color));
  }
  if (annotation.badge) parts.push(badgeCircle(x, y, annotation.badge, annotation.color));
  return parts.join('');
}

function coverShape(annotation) {
  const [x, y, width, height] = annotation.rect;
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" ` +
    `fill="${COVER_FILL}" stroke="${COVER_STROKE}" stroke-width="1"/>`;
}

function arrowShape(annotation) {
  const [fromX, fromY] = annotation.from;
  const [toX, toY] = annotation.to;
  const color = annotationColor(annotation.color);
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const headLength = 12;
  const headAngle = Math.PI / 7;
  const leftX = toX - headLength * Math.cos(angle - headAngle);
  const leftY = toY - headLength * Math.sin(angle - headAngle);
  const rightX = toX - headLength * Math.cos(angle + headAngle);
  const rightY = toY - headLength * Math.sin(angle + headAngle);
  const head = `${toX},${toY} ${leftX.toFixed(1)},${leftY.toFixed(1)} ${rightX.toFixed(1)},${rightY.toFixed(1)}`;
  return [
    `<line x1="${fromX}" y1="${fromY}" x2="${toX}" y2="${toY}" stroke="#FFFFFF" ` +
      'stroke-width="5" stroke-linecap="round"/>',
    `<line x1="${fromX}" y1="${fromY}" x2="${toX}" y2="${toY}" stroke="${color}" ` +
      'stroke-width="2.5" stroke-linecap="round"/>',
    `<polygon points="${head}" fill="${color}" stroke="#FFFFFF" stroke-width="1"/>`,
  ].join('');
}

const SHAPES = {
  box: boxShape,
  cover: coverShape,
  arrow: arrowShape,
  badge: (annotation) => badgeCircle(annotation.at[0], annotation.at[1], annotation.number, annotation.color),
  label: (annotation) => labelPill(annotation.at[0], annotation.at[1], annotation.text, annotation.color),
};

const LAYER_ORDER = ['cover', 'arrow', 'box', 'label', 'badge'];

export function buildOverlaySvg({ width, height, annotations }) {
  const layers = annotations
    .filter((annotation) => annotation.type !== 'blur')
    .sort((left, right) => LAYER_ORDER.indexOf(left.type) - LAYER_ORDER.indexOf(right.type))
    .map((annotation) => SHAPES[annotation.type](annotation));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">${layers.join('')}</svg>`;
}

export function roundedRectMaskSvg(width, height, radius = 8) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" fill="#FFFFFF"/></svg>`;
}
