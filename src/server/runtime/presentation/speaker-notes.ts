/** Older plans appended the editable source after the audience-facing notes. */
export const audienceSpeakerNotes = (notes: string | undefined): string | undefined => {
  if (notes === undefined) return undefined;
  const appendix = notes.indexOf('[可编辑内容源]');
  return appendix < 0 ? notes : notes.slice(0, appendix).trimEnd();
};
