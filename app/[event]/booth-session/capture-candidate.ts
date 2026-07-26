type DecodeImage = (source: Blob) => Promise<ImageBitmap>;
type CreateCanvas = () => HTMLCanvasElement;

export async function decodePhotoFileToCanvas(
  file: Blob,
  decode: DecodeImage = (source) => createImageBitmap(source),
  createCanvas: CreateCanvas = () => document.createElement("canvas"),
): Promise<HTMLCanvasElement> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await decode(file);
  } catch {
    throw new Error("Could not decode this photo. Please take another one.");
  }

  try {
    if (
      !Number.isFinite(bitmap.width)
      || !Number.isFinite(bitmap.height)
      || bitmap.width <= 0
      || bitmap.height <= 0
    ) {
      throw new Error("invalid decoded dimensions");
    }
    const canvas = createCanvas();
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    context.drawImage(bitmap, 0, 0);
    return canvas;
  } catch {
    throw new Error("Could not decode this photo. Please take another one.");
  } finally {
    bitmap.close();
  }
}
