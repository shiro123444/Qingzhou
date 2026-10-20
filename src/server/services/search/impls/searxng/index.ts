import { type UniformSearchResponse, type UniformSearchResult } from '@lobechat/types';
import { SEARCH_SEARXNG_NOT_CONFIG } from '@lobechat/types';
import { TRPCError } from '@trpc/server';

import { toolsEnv } from '@/envs/tools';
import {
  SearXNGClient,
  type SearXNGSearchResult,
} from '@/server/services/search/impls/searxng/client';

import { type SearchServiceImpl } from '../type';

const isValidHttpUrl = (rawUrl?: string): boolean => {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const extractEngineName = (item: unknown): string => {
  if (Array.isArray(item) && typeof item[0] === 'string') return item[0];
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && 'engine' in item && typeof item.engine === 'string') {
    return item.engine;
  }
  return '';
};

/**
 * SearXNG implementation of the search service
 */
export class SearXNGImpl implements SearchServiceImpl {
  async query(
    query: string,
    params?: {
      searchCategories?: string[];
      searchEngines?: string[];
      searchTimeRange?: string;
    },
  ): Promise<UniformSearchResponse> {
    if (!toolsEnv.SEARXNG_URL) {
      throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: SEARCH_SEARXNG_NOT_CONFIG });
    }

    const client = new SearXNGClient(toolsEnv.SEARXNG_URL);

    try {
      const startAt = Date.now();
      const data = await client.search(query, {
        categories: params?.searchCategories,
        engines: params?.searchEngines,
        time_range: params?.searchTimeRange,
      });
      const costTime = Date.now() - startAt;

      const rawResults = Array.isArray(data.results) ? data.results : [];
      const unresponsiveEngines = Array.isArray(data.unresponsive_engines)
        ? data.unresponsive_engines
        : [];

      // Filter out invalid URLs (non-http/https or malformed)
      const validResults = rawResults.filter((item): item is SearXNGSearchResult =>
        Boolean(item && isValidHttpUrl(item.url)),
      );

      // 1. If valid results exist, return them normally even if some engines failed
      if (validResults.length > 0) {
        return {
          costTime,
          query,
          resultNumbers: data.number_of_results || validResults.length,
          results: validResults.map(
            (item: SearXNGSearchResult): UniformSearchResult => ({
              category: item.category || 'general',
              content: item.content ?? '',
              engines: Array.isArray(item.engines)
                ? item.engines
                : item.engine
                  ? [item.engine]
                  : [],
              parsedUrl: new URL(item.url).hostname,
              publishedDate: item.publishedDate || undefined,
              score: typeof item.score === 'number' ? item.score : 0,
              thumbnail: item.thumbnail || undefined,
              title: item.title || '',
              url: item.url,
            }),
          ),
        };
      }

      // 2. Results are empty: check engine failure status
      if (unresponsiveEngines.length === 0) {
        return {
          costTime,
          query,
          resultNumbers: 0,
          results: [],
        };
      }

      // 3. Results are empty and some engines failed:
      const explicitEngines = params?.searchEngines?.filter(Boolean) || [];

      if (explicitEngines.length > 0) {
        const failedEngineSet = new Set(
          unresponsiveEngines
            .map(extractEngineName)
            .filter(Boolean)
            .map((name) => name.toLowerCase()),
        );

        const allExplicitFailed = explicitEngines.every((eng) =>
          failedEngineSet.has(eng.toLowerCase()),
        );

        if (allExplicitFailed) {
          throw new TRPCError({
            code: 'SERVICE_UNAVAILABLE',
            message: `所有指定搜索引擎均失败: ${explicitEngines.join(', ')}`,
          });
        }

        // 显式 engine 仅部分失败且 0 统一报 SEARCH_INCOMPLETE
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'SEARCH_INCOMPLETE: 检索不完整，请重试',
        });
      }

      // 4. No explicit engines: report SEARCH_INCOMPLETE with engine detail
      const failedEngineNames = unresponsiveEngines.map(extractEngineName).filter(Boolean);
      const engineDetail = failedEngineNames.length > 0 ? ` (${failedEngineNames.join(', ')})` : '';

      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: `SEARCH_INCOMPLETE: 检索不完整，请重试${engineDetail}`,
      });
    } catch (e) {
      if (e instanceof TRPCError) {
        throw e;
      }

      console.error(e);

      throw new TRPCError({
        cause: e,
        code: 'SERVICE_UNAVAILABLE',
        message: '搜索服务暂不可用',
      });
    }
  }
}
