import { lambdaClient } from '@/libs/trpc/client';
import type {
  ActivityCategory,
  ActivityListInput,
  ActivityReviewInput,
} from '@/types/backgroundActivity';

export const backgroundActivityService = {
  list: (input: ActivityListInput = {}) => lambdaClient.backgroundActivity.list.query(input),
  health: () => lambdaClient.backgroundActivity.health.query(),
  reviewHistory: (input: { category: ActivityCategory; id: string }) =>
    lambdaClient.backgroundActivity.reviewHistory.query(input),
  recordReview: (input: ActivityReviewInput) =>
    lambdaClient.backgroundActivity.recordReview.mutate(input),
};
