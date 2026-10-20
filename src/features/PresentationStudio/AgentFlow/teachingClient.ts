import {
  type TeachingRecord,
  teachingRecordSchema,
  type TeachingReview,
  type TeachingSourceReference,
} from '@/types/presentationTeaching';

const request = async (body?: unknown) => {
  const response = await fetch(
    '/api/runtime/presentation/teaching',
    body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error?.message ?? 'Teaching memory unavailable');
  return result;
};
export const teachingClient = {
  async list(): Promise<TeachingRecord[]> {
    return (await request()).records.map((record: unknown) => teachingRecordSchema.parse(record));
  },
  async analyze(reference: TeachingSourceReference): Promise<TeachingRecord[]> {
    return (await request({ action: 'analyze', reference })).records.map((record: unknown) =>
      teachingRecordSchema.parse(record),
    );
  },
  async review(review: TeachingReview): Promise<TeachingRecord> {
    return teachingRecordSchema.parse((await request({ action: 'review', review })).record);
  },
};
