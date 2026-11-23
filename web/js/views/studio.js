import { renderCreate } from "./create.js";

// Unified Studio view: a single workspace supporting both single-image and
// multi-image planning/generation aligned with handraw-web (#53).
export async function renderStudio(root, ctx, params = {}) {
  await renderCreate(root, ctx, params);
}
