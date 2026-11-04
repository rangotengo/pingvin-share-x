export type EditFinish = "complete" | "delete-share";

/** Empty edit must delete the share. complete() rejects a share with no files. */
export function editFinishAction(
  keptFiles: number,
  newFiles: number,
): EditFinish {
  if (keptFiles + newFiles <= 0) return "delete-share";
  return "complete";
}
