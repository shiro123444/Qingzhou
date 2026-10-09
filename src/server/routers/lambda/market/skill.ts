import { TRPCError } from '@trpc/server';
import debug from 'debug';
import { z } from 'zod';

import { publicProcedure, router } from '@/libs/trpc/lambda';
import { marketUserInfo, serverDatabase } from '@/libs/trpc/lambda/middleware';
import { MarketService } from '@/server/services/market';
import { marketDetailError } from '@/server/services/market/readPublicDetail';
import { NexusRegistryService } from '@/server/services/nexusRegistry';
import { type SkillCategoryItem, type SkillListResponse, SkillSorts } from '@/types/discover';

const log = debug('lambda-router:market:skill');

const getMergedPageParams = (input?: { page?: number; pageSize?: number }) => {
  const page = Math.max(1, Number(input?.page || 1));
  const pageSize = Math.max(1, Number(input?.pageSize || 20));

  return {
    fetchPageSize: Math.min(100, page * pageSize),
    page,
    pageSize,
  };
};

const mergeCategoryItems = (
  localCategories: SkillCategoryItem[] = [],
  upstreamCategories: SkillCategoryItem[] = [],
): SkillCategoryItem[] => {
  const map = new Map<string, SkillCategoryItem>();

  for (const item of upstreamCategories) {
    map.set(item.category, { ...item });
  }

  for (const item of localCategories) {
    const current = map.get(item.category);
    map.set(item.category, {
      category: item.category,
      count: (current?.count ?? 0) + item.count,
    });
  }

  return [...map.values()];
};

const mergePagedItems = (
  localItems: SkillListResponse['items'] = [],
  upstreamItems: SkillListResponse['items'] = [],
  params: { page: number; pageSize: number },
): SkillListResponse['items'] => {
  const merged = new Map<string, SkillListResponse['items'][number]>();

  for (const item of localItems) {
    merged.set(item.identifier, item);
  }

  for (const item of upstreamItems) {
    if (!merged.has(item.identifier)) merged.set(item.identifier, item);
  }

  const offset = (params.page - 1) * params.pageSize;
  return [...merged.values()].slice(offset, offset + params.pageSize);
};

const mergeSkillLists = (
  localList: SkillListResponse,
  upstreamList: SkillListResponse | undefined,
  params: { page: number; pageSize: number },
): SkillListResponse => {
  const duplicateCount = new Set(localList.items.map((item) => item.identifier));
  const fetchedDuplicateCount = (upstreamList?.items ?? []).filter((item) =>
    duplicateCount.has(item.identifier),
  ).length;
  const totalCount = Math.max(
    0,
    localList.totalCount + (upstreamList?.totalCount ?? 0) - fetchedDuplicateCount,
  );

  return {
    categories: mergeCategoryItems(localList.categories, upstreamList?.categories),
    currentPage: params.page,
    items: mergePagedItems(localList.items, upstreamList?.items, params),
    pageSize: params.pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / params.pageSize),
  };
};

// Public procedure with optional user info for trusted client token
const marketProcedure = publicProcedure
  .use(serverDatabase)
  .use(marketUserInfo)
  .use(async ({ ctx, next }) => {
    return next({
      ctx: {
        marketService: new MarketService({
          accessToken: ctx.marketAccessToken,
          userInfo: ctx.marketUserInfo,
        }),
        nexusRegistryService: new NexusRegistryService(ctx.serverDB),
      },
    });
  });

export const skillRouter = router({
  getSkillCategories: marketProcedure
    .input(
      z
        .object({
          locale: z.string().optional(),
          q: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      log('getSkillCategories input: %O', input);

      try {
        const [localResult, upstreamResult] = await Promise.allSettled([
          ctx.nexusRegistryService.listCategories('skill', {
            q: input?.q,
          }),
          ctx.marketService.getSkillCategories(),
        ]);
        const localCategories = localResult.status === 'fulfilled' ? localResult.value : [];
        if (localResult.status === 'rejected') {
          log('Qingzhou registry skill categories fallback: %O', localResult.reason);
        }

        if (upstreamResult.status === 'fulfilled') {
          return mergeCategoryItems(localCategories, upstreamResult.value);
        }

        log('Error fetching upstream skill categories: %O', upstreamResult.reason);
        if (localCategories.length > 0) return localCategories;

        throw upstreamResult.reason;
      } catch (error) {
        log('Error fetching skill categories: %O', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch skill categories',
        });
      }
    }),

  getSkillDetail: marketProcedure
    .input(
      z.object({
        identifier: z.string(),
        locale: z.string().optional(),
        version: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      log('getSkillDetail input: %O', input);

      try {
        const localDetail = await ctx.nexusRegistryService
          .getSkillDetail(input.identifier)
          .catch((error) => {
            log('Qingzhou registry skill detail fallback: %O', error);
            return undefined;
          });
        if (localDetail) return localDetail;

        return await ctx.marketService.getSkillDetail(input.identifier, {
          locale: input.locale,
          version: input.version,
        });
      } catch (error) {
        log('Error fetching skill detail: %O', error);
        throw marketDetailError(error, 'Failed to fetch skill detail');
      }
    }),

  getSkillList: marketProcedure
    .input(
      z
        .object({
          category: z.string().optional(),
          locale: z.string().optional(),
          order: z.enum(['asc', 'desc']).optional(),
          page: z.number().optional(),
          pageSize: z.number().optional(),
          q: z.string().optional(),
          sort: z.nativeEnum(SkillSorts).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      log('getSkillList input: %O', input);

      try {
        const { fetchPageSize, page, pageSize } = getMergedPageParams(input);
        const localList = await ctx.nexusRegistryService
          .listSkills({
            ...input,
            page: 1,
            pageSize: fetchPageSize,
          })
          .catch((error) => {
            log('Qingzhou registry skill list fallback: %O', error);
            return undefined;
          });

        if (!localList || localList.totalCount === 0)
          return await ctx.marketService.searchSkill(input ?? {});

        const upstreamList = await ctx.marketService
          .searchSkill({
            ...input,
            page: 1,
            pageSize: fetchPageSize,
          })
          .catch((error) => {
            log('Error fetching upstream skill list, using Qingzhou registry only: %O', error);
            return undefined;
          });

        return mergeSkillLists(localList, upstreamList, { page, pageSize });
      } catch (error) {
        log('Error fetching skill list: %O', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch skill list',
        });
      }
    }),
});
