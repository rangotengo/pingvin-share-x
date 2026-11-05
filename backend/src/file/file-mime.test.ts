import assert from "node:assert/strict";
import test from "node:test";
import mime from "mime-types";

// Shared logic mirroring frontend shareService.getFileMimeType and backend file mime lookup
function getFileMimeType(fileName: string): string {
  const baseName = fileName.split(/[/\\]/).pop() || fileName;
  return (mime.contentType(baseName) || "").split(";")[0];
}

function doesFileSupportPreview(fileName: string): boolean {
  const mimeType = getFileMimeType(fileName);
  if (!mimeType) return false;
  const supported = [
    mimeType.startsWith("video/"),
    mimeType.startsWith("image/"),
    mimeType.startsWith("audio/"),
    mimeType.startsWith("text/"),
    mimeType === "application/pdf",
  ];
  return supported.some(Boolean);
}

function isShareTextFile(fileName: string): boolean {
  const mimeType = getFileMimeType(fileName);
  if (!mimeType) return false;
  return mimeType.startsWith("text/");
}

test("nested path with forward slash resolves image, video, audio, text, pdf", () => {
  assert.equal(getFileMimeType("Photos/Holiday/IMG_0001.jpg"), "image/jpeg");
  assert.equal(doesFileSupportPreview("Photos/Holiday/IMG_0001.jpg"), true);

  assert.equal(getFileMimeType("Videos/Vacation/clip.mp4"), "video/mp4");
  assert.equal(doesFileSupportPreview("Videos/Vacation/clip.mp4"), true);

  assert.equal(getFileMimeType("Music/Albums/track.mp3"), "audio/mpeg");
  assert.equal(doesFileSupportPreview("Music/Albums/track.mp3"), true);

  assert.equal(getFileMimeType("Documents/Notes/todo.txt"), "text/plain");
  assert.equal(doesFileSupportPreview("Documents/Notes/todo.txt"), true);
  assert.equal(isShareTextFile("Documents/Notes/todo.txt"), true);

  assert.equal(getFileMimeType("Documents/Invoices/invoice.pdf"), "application/pdf");
  assert.equal(doesFileSupportPreview("Documents/Invoices/invoice.pdf"), true);
  assert.equal(isShareTextFile("Documents/Invoices/invoice.pdf"), false);
});

test("nested path with backslash and mixed slashes resolves properly", () => {
  assert.equal(getFileMimeType("Photos\\Holiday\\IMG_0001.png"), "image/png");
  assert.equal(doesFileSupportPreview("Photos\\Holiday\\IMG_0001.png"), true);

  assert.equal(getFileMimeType("deep/nested\\mixed/path\\log.txt"), "text/plain");
  assert.equal(isShareTextFile("deep/nested\\mixed/path\\log.txt"), true);
});

test("SVG file preserves image/svg+xml MIME type for security gating", () => {
  assert.equal(getFileMimeType("Assets/Icons/logo.svg"), "image/svg+xml");
  assert.equal(doesFileSupportPreview("Assets/Icons/logo.svg"), true);
  assert.equal(isShareTextFile("Assets/Icons/logo.svg"), false);
});

test("unknown or missing extension returns empty and no preview support", () => {
  assert.equal(getFileMimeType("Folder/Subfolder/unknown.xyz999"), "");
  assert.equal(doesFileSupportPreview("Folder/Subfolder/unknown.xyz999"), false);
  assert.equal(isShareTextFile("Folder/Subfolder/unknown.xyz999"), false);

  assert.equal(getFileMimeType("Folder/Subfolder/noextension"), "");
  assert.equal(doesFileSupportPreview("Folder/Subfolder/noextension"), false);
});
