const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..");
const assetsDir = path.join(rootDir, "assets");
const publicDir = path.join(rootDir, "public");
const iconSizes = [16, 24, 32, 48, 64, 128, 256];
const keyRoundPath =
  "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z";
const brandTile = {
  bottom: 256,
  left: 0,
  radius: (8 / 42) * 256,
  right: 256,
  top: 0
};
const brandIconScale = ((22 / 42) * 256) / 24;
const brandIconOffset = (256 - 24 * brandIconScale) / 2;
const brandIconTransform = `translate(${formatNumber(brandIconOffset)} ${formatNumber(brandIconOffset)}) scale(${formatNumber(brandIconScale)})`;
const keyRoundPolylines = pathToPolylines(keyRoundPath);
const gradientStops = [
  { color: hexToRgb("#0a84ff"), offset: 0 },
  { color: hexToRgb("#007aff"), offset: 0.48 },
  { color: hexToRgb("#5856d6"), offset: 1 }
];
const white = hexToRgb("#ffffff");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="256" y2="256" gradientUnits="userSpaceOnUse">
      <stop stop-color="#0a84ff"/>
      <stop offset="0.48" stop-color="#007aff"/>
      <stop offset="1" stop-color="#5856d6"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="${formatNumber(brandTile.radius)}" fill="url(#bg)"/>
  <rect width="256" height="256" rx="${formatNumber(brandTile.radius)}" fill="none" stroke="#ffffff" stroke-opacity="0.28" stroke-width="3"/>
  <g transform="${brandIconTransform}" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="${keyRoundPath}"/>
    <circle cx="16.5" cy="7.5" r=".5" fill="#ffffff"/>
  </g>
</svg>
`;

function formatNumber(value) {
  return Number.parseFloat(value.toFixed(3)).toString();
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.replace("#", ""), 16);

  return {
    b: value & 255,
    g: (value >> 8) & 255,
    r: (value >> 16) & 255
  };
}

function mix(left, right, ratio) {
  return {
    b: Math.round(left.b + (right.b - left.b) * ratio),
    g: Math.round(left.g + (right.g - left.g) * ratio),
    r: Math.round(left.r + (right.r - left.r) * ratio)
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function interpolateGradient(ratio) {
  const t = clamp(ratio, 0, 1);

  for (let index = 1; index < gradientStops.length; index += 1) {
    const previous = gradientStops[index - 1];
    const next = gradientStops[index];

    if (t <= next.offset) {
      return mix(previous.color, next.color, (t - previous.offset) / (next.offset - previous.offset));
    }
  }

  return gradientStops[gradientStops.length - 1].color;
}

function brandGradientColor(x, y) {
  const angle = (145 * Math.PI) / 180;
  const directionX = Math.sin(angle);
  const directionY = -Math.cos(angle);
  const corners = [
    brandTile.left * directionX + brandTile.top * directionY,
    brandTile.right * directionX + brandTile.top * directionY,
    brandTile.left * directionX + brandTile.bottom * directionY,
    brandTile.right * directionX + brandTile.bottom * directionY
  ];
  const minimum = Math.min(...corners);
  const maximum = Math.max(...corners);
  const projection = x * directionX + y * directionY;

  return interpolateGradient((projection - minimum) / (maximum - minimum));
}

function tokenizePath(pathData) {
  return pathData.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g) ?? [];
}

function isCommand(token) {
  return /^[a-zA-Z]$/.test(token);
}

function vectorAngle(ux, uy, vx, vy) {
  const dot = ux * vx + uy * vy;
  const length = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;

  return sign * Math.acos(clamp(dot / length, -1, 1));
}

function arcToPoints(x1, y1, rx, ry, rotation, largeArcFlag, sweepFlag, x2, y2) {
  if (rx === 0 || ry === 0) {
    return [{ x: x2, y: y2 }];
  }

  const phi = (rotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const halfDeltaX = (x1 - x2) / 2;
  const halfDeltaY = (y1 - y2) / 2;
  const x1Prime = cosPhi * halfDeltaX + sinPhi * halfDeltaY;
  const y1Prime = -sinPhi * halfDeltaX + cosPhi * halfDeltaY;
  let radiusX = Math.abs(rx);
  let radiusY = Math.abs(ry);
  const radiusScale = x1Prime ** 2 / radiusX ** 2 + y1Prime ** 2 / radiusY ** 2;

  if (radiusScale > 1) {
    const scale = Math.sqrt(radiusScale);
    radiusX *= scale;
    radiusY *= scale;
  }

  const numerator =
    radiusX ** 2 * radiusY ** 2 - radiusX ** 2 * y1Prime ** 2 - radiusY ** 2 * x1Prime ** 2;
  const denominator = radiusX ** 2 * y1Prime ** 2 + radiusY ** 2 * x1Prime ** 2;
  const centerRatio = (largeArcFlag === sweepFlag ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const centerXPrime = centerRatio * ((radiusX * y1Prime) / radiusY);
  const centerYPrime = centerRatio * (-(radiusY * x1Prime) / radiusX);
  const centerX = cosPhi * centerXPrime - sinPhi * centerYPrime + (x1 + x2) / 2;
  const centerY = sinPhi * centerXPrime + cosPhi * centerYPrime + (y1 + y2) / 2;
  const startVectorX = (x1Prime - centerXPrime) / radiusX;
  const startVectorY = (y1Prime - centerYPrime) / radiusY;
  const endVectorX = (-x1Prime - centerXPrime) / radiusX;
  const endVectorY = (-y1Prime - centerYPrime) / radiusY;
  const startAngle = vectorAngle(1, 0, startVectorX, startVectorY);
  let sweepAngle = vectorAngle(startVectorX, startVectorY, endVectorX, endVectorY);

  if (!sweepFlag && sweepAngle > 0) {
    sweepAngle -= 2 * Math.PI;
  } else if (sweepFlag && sweepAngle < 0) {
    sweepAngle += 2 * Math.PI;
  }

  const segmentCount = Math.max(4, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 20)));
  const points = [];

  for (let segment = 1; segment <= segmentCount; segment += 1) {
    const theta = startAngle + (sweepAngle * segment) / segmentCount;
    const pointX = centerX + cosPhi * radiusX * Math.cos(theta) - sinPhi * radiusY * Math.sin(theta);
    const pointY = centerY + sinPhi * radiusX * Math.cos(theta) + cosPhi * radiusY * Math.sin(theta);

    points.push({ x: pointX, y: pointY });
  }

  return points;
}

function pathToPolylines(pathData) {
  const tokens = tokenizePath(pathData);
  const polylines = [];
  let command = "";
  let currentX = 0;
  let currentY = 0;
  let index = 0;
  let subpathStartX = 0;
  let subpathStartY = 0;
  let polyline = [];

  function hasNumber() {
    return index < tokens.length && !isCommand(tokens[index]);
  }

  function readNumber() {
    const value = Number.parseFloat(tokens[index]);
    index += 1;

    return value;
  }

  function pushPoint(point) {
    const previous = polyline[polyline.length - 1];

    if (!previous || Math.abs(previous.x - point.x) > 0.0001 || Math.abs(previous.y - point.y) > 0.0001) {
      polyline.push(point);
    }
  }

  function finishPolyline() {
    if (polyline.length > 1) {
      polylines.push(polyline);
    }

    polyline = [];
  }

  while (index < tokens.length) {
    if (isCommand(tokens[index])) {
      command = tokens[index];
      index += 1;
    }

    const relative = command === command.toLowerCase();

    switch (command.toLowerCase()) {
      case "m": {
        let isFirstPoint = true;

        while (hasNumber()) {
          const nextX = readNumber();
          const nextY = readNumber();
          const x = relative ? currentX + nextX : nextX;
          const y = relative ? currentY + nextY : nextY;

          if (isFirstPoint) {
            finishPolyline();
            polyline = [{ x, y }];
            subpathStartX = x;
            subpathStartY = y;
            isFirstPoint = false;
          } else {
            pushPoint({ x, y });
          }

          currentX = x;
          currentY = y;
        }

        command = relative ? "l" : "L";
        break;
      }

      case "l": {
        while (hasNumber()) {
          const nextX = readNumber();
          const nextY = readNumber();
          currentX = relative ? currentX + nextX : nextX;
          currentY = relative ? currentY + nextY : nextY;
          pushPoint({ x: currentX, y: currentY });
        }

        break;
      }

      case "h": {
        while (hasNumber()) {
          const nextX = readNumber();
          currentX = relative ? currentX + nextX : nextX;
          pushPoint({ x: currentX, y: currentY });
        }

        break;
      }

      case "v": {
        while (hasNumber()) {
          const nextY = readNumber();
          currentY = relative ? currentY + nextY : nextY;
          pushPoint({ x: currentX, y: currentY });
        }

        break;
      }

      case "a": {
        while (hasNumber()) {
          const radiusX = readNumber();
          const radiusY = readNumber();
          const rotation = readNumber();
          const largeArcFlag = readNumber();
          const sweepFlag = readNumber();
          const nextX = readNumber();
          const nextY = readNumber();
          const targetX = relative ? currentX + nextX : nextX;
          const targetY = relative ? currentY + nextY : nextY;

          for (const point of arcToPoints(
            currentX,
            currentY,
            radiusX,
            radiusY,
            rotation,
            Boolean(largeArcFlag),
            Boolean(sweepFlag),
            targetX,
            targetY
          )) {
            pushPoint(point);
          }

          currentX = targetX;
          currentY = targetY;
        }

        break;
      }

      case "z":
        pushPoint({ x: subpathStartX, y: subpathStartY });
        currentX = subpathStartX;
        currentY = subpathStartY;
        finishPolyline();
        command = "";
        break;

      default:
        throw new Error(`Unsupported SVG path command: ${command}`);
    }
  }

  finishPolyline();

  return polylines;
}

function isInsideRoundedRect(x, y, left, top, right, bottom, radius) {
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const halfWidth = (right - left) / 2;
  const halfHeight = (bottom - top) / 2;
  const qx = Math.abs(x - centerX) - halfWidth + radius;
  const qy = Math.abs(y - centerY) - halfHeight + radius;
  const outsideX = Math.max(qx, 0);
  const outsideY = Math.max(qy, 0);
  const outsideDistance = Math.sqrt(outsideX * outsideX + outsideY * outsideY);
  const insideDistance = Math.min(Math.max(qx, qy), 0);

  return outsideDistance + insideDistance <= radius;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + ratio * dx;
  const y = ay + ratio * dy;
  const deltaX = px - x;
  const deltaY = py - y;

  return Math.sqrt(deltaX * deltaX + deltaY * deltaY);
}

function renderIcon(size) {
  const supersample = size <= 32 ? 4 : 3;
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;

      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const ux = ((x + (sx + 0.5) / supersample) / size) * 256;
          const uy = ((y + (sy + 0.5) / supersample) / size) * 256;
          let sampleAlpha = 0;
          let sampleColor = { b: 0, g: 0, r: 0 };

          if (
            isInsideRoundedRect(
              ux,
              uy,
              brandTile.left,
              brandTile.top,
              brandTile.right,
              brandTile.bottom,
              brandTile.radius
            )
          ) {
            sampleAlpha = 255;
            sampleColor = brandGradientColor(ux, uy);
          }

          if (sampleAlpha > 0) {
            const iconX = (ux - brandIconOffset) / brandIconScale;
            const iconY = (uy - brandIconOffset) / brandIconScale;

            for (const polyline of keyRoundPolylines) {
              for (let pointIndex = 1; pointIndex < polyline.length; pointIndex += 1) {
                const start = polyline[pointIndex - 1];
                const end = polyline[pointIndex];

                if (distanceToSegment(iconX, iconY, start.x, start.y, end.x, end.y) <= 1) {
                  sampleColor = white;
                  break;
                }
              }

              if (sampleColor === white) {
                break;
              }
            }

            if (Math.sqrt((iconX - 16.5) ** 2 + (iconY - 7.5) ** 2) <= 1.5) {
              sampleColor = white;
            }
          }

          alpha += sampleAlpha;
          red += sampleColor.r * sampleAlpha;
          green += sampleColor.g * sampleAlpha;
          blue += sampleColor.b * sampleAlpha;
        }
      }

      const sampleCount = supersample * supersample;
      const nextAlpha = Math.round(alpha / sampleCount);
      const offset = (y * size + x) * 4;

      if (nextAlpha > 0) {
        pixels[offset] = Math.round(blue / alpha);
        pixels[offset + 1] = Math.round(green / alpha);
        pixels[offset + 2] = Math.round(red / alpha);
        pixels[offset + 3] = nextAlpha;
      }
    }
  }

  return pixels;
}

function createDib(size) {
  const pixels = renderIcon(size);
  const headerSize = 40;
  const xorSize = size * size * 4;
  const andStride = Math.ceil(size / 32) * 4;
  const andSize = andStride * size;
  const dib = Buffer.alloc(headerSize + xorSize + andSize);

  dib.writeUInt32LE(headerSize, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16);
  dib.writeUInt32LE(xorSize, 20);
  dib.writeInt32LE(0, 24);
  dib.writeInt32LE(0, 28);
  dib.writeUInt32LE(0, 32);
  dib.writeUInt32LE(0, 36);

  for (let y = 0; y < size; y += 1) {
    const sourceY = size - 1 - y;
    pixels.copy(dib, headerSize + y * size * 4, sourceY * size * 4, (sourceY + 1) * size * 4);
  }

  return dib;
}

function createIco(sizes) {
  const entries = sizes.map((size) => ({
    dib: createDib(size),
    size
  }));
  const headerSize = 6 + entries.length * 16;
  const header = Buffer.alloc(headerSize);
  let offset = headerSize;

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  entries.forEach((entry, index) => {
    const entryOffset = 6 + index * 16;

    header.writeUInt8(entry.size === 256 ? 0 : entry.size, entryOffset);
    header.writeUInt8(entry.size === 256 ? 0 : entry.size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(entry.dib.length, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);
    offset += entry.dib.length;
  });

  return Buffer.concat([header, ...entries.map((entry) => entry.dib)]);
}

fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, "app-icon.svg"), svg);
fs.writeFileSync(path.join(publicDir, "favicon.svg"), svg);
fs.writeFileSync(path.join(assetsDir, "app-icon.ico"), createIco(iconSizes));
