import images from "../fixtures/decision-images.json";
import { deflateSync } from "node:zlib";

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < chunk.length - 4; i++) {
    crc ^= chunk[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

let screenshot;
/** Valid grayscale PNG at the user's previously rejected 24.5 MP dimensions. */
export function decisionScreenshot() {
  if (!screenshot) {
    const width = 4284, height = 5712;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8;
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))), pngChunk("IEND", Buffer.alloc(0)),
    ]);
    screenshot = { type: "image", mediaType: "image/png", data: bytes.toString("base64") };
  }
  return { ...screenshot };
}

/** A valid small PNG padded with a standard ancillary text chunk. */
export function sizedDecisionPng(byteLength) {
  const original = Buffer.from(images["image/png"], "base64");
  const chunk = Buffer.alloc(byteLength - original.length, 97);
  chunk.writeUInt32BE(chunk.length - 12, 0);
  chunk.write("tEXtComment\0", 4, "ascii");
  let crc = 0xffffffff;
  for (let i = 4; i < chunk.length - 4; i++) {
    crc ^= chunk[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([original.subarray(0, -12), chunk, original.subarray(-12)]).toString("base64");
}
