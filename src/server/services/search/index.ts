import type { SearchParams, SearchQuery, UniformSearchResponse } from '@lobechat/types';
import type { Crawler, CrawlImplType, CrawlUniformResult } from '@lobechat/web-crawler';
import { TRPCError } from '@trpc/server';
import debug from 'debug';
import pMap from 'p-map';

import { toolsEnv } from '@/envs/tools';

import { type SearchImplType, type SearchServiceImpl } from './impls';
import { createSearchServiceImpl } from './impls';

const DEFAULT_CRAWL_CONCURRENCY = 3;
const DEFAULT_CRAWLER_RETRY = 1;
/**
 * Fixed client-facing message for an incomplete search. Never echo provider or
 * engine output here — those stay server-side in the recorded cause.
 */
const SEARCH_INCOMPLETE_MESSAGE = 'SEARCH_INCOMPLETE: 检索不完整，请重试';
const log = debug('lobe-oom:web-browsing:search-service');

const parseImplEnv = (envString: string = '') => {
  // Handle full-width commas and extra whitespace
  const envValue = envString.replaceAll('，', ',').trim();
  return envValue
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const getMemorySnapshot = () => {
  if (typeof process === 'undefined' || typeof process.memoryUsage !== 'function') {
    return 'non-node';
  }

  const { heapUsed, rss } = process.memoryUsage();

  return `rss=${(rss / 1024 / 1024).toFixed(1)}MB heap=${(heapUsed / 1024 / 1024).toFixed(1)}MB`;
};

/**
 * Search service class
 * Uses different implementations for different search operations
 */
export class SearchService {
  private searchImpList: SearchServiceImpl[];

  private get crawlerImpls() {
    return parseImplEnv(toolsEnv.CRAWLER_IMPLS);
  }

  private get crawlConcurrency() {
    return toolsEnv.CRAWL_CONCURRENCY ?? DEFAULT_CRAWL_CONCURRENCY;
  }

  private get crawlerRetry() {
    return toolsEnv.CRAWLER_RETRY ?? DEFAULT_CRAWLER_RETRY;
  }

  constructor() {
    const impls = this.searchImpls;
    this.searchImpList =
      impls.length > 0
        ? impls.map((impl) => createSearchServiceImpl(impl))
        : [createSearchServiceImpl()];
  }

  async crawlPages(input: { impls?: CrawlImplType[]; urls: string[] }) {
    try {
      if (log.enabled) {
        log(
          'crawlPages:start urls=%d impls=%s mem=%s',
          input.urls.length,
          (input.impls || this.crawlerImpls).join(',') || '-',
          getMemorySnapshot(),
        );
      }
    } catch {}

    const { Crawler } = await import('@lobechat/web-crawler');
    const crawler = new Crawler({ impls: this.crawlerImpls });

    const results = await pMap(
      input.urls,
      async (url) => {
        return await this.crawlWithRetry(crawler, url, input.impls);
      },
      { concurrency: this.crawlConcurrency },
    );

    return { results };
  }

  private async crawlWithRetry(
    crawler: Crawler,
    url: string,
    impls?: CrawlImplType[],
  ): Promise<CrawlUniformResult> {
    const maxAttempts = this.crawlerRetry + 1;
    let lastResult: CrawlUniformResult | undefined;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await crawler.crawl({ impls, url });
        try {
          if (log.enabled) {
            log('crawlWithRetry:result crawler=%s mem=%s', result.crawler, getMemorySnapshot());
          }
        } catch {}
        lastResult = result;

        if (!this.isFailedCrawlResult(result)) {
          return result;
        }
      } catch (error) {
        lastError = error as Error;
      }
    }

    if (lastResult) {
      return lastResult;
    }

    return {
      crawler: 'unknown',
      data: {
        content: `Fail to crawl the page. Error type: ${lastError?.name || 'UnknownError'}, error message: ${lastError?.message}`,
        errorMessage: lastError?.message,
        errorType: lastError?.name || 'UnknownError',
      },
      originalUrl: url,
    };
  }

  /**
   * A successful crawl result always includes `contentType` (e.g. 'text', 'json')
   * in `result.data`, while a failed result contains `errorType`/`errorMessage` instead.
   */
  private isFailedCrawlResult(result: CrawlUniformResult): boolean {
    return !('contentType' in result.data);
  }

  private get searchImpls() {
    return parseImplEnv(toolsEnv.SEARCH_PROVIDERS) as SearchImplType[];
  }

  /**
   * Query for search results using the specified impl
   */
  private async queryWithImpl(
    impl: SearchServiceImpl,
    query: string,
    params?: SearchParams,
  ): Promise<UniformSearchResponse> {
    try {
      return await impl.query(query, params);
    } catch (e) {
      // A failure must stay detectable by the aggregator below, so always record
      // a non-empty errorDetail (the existing contract) without echoing it out.
      const message = (e instanceof Error ? e.message : String(e)) || '搜索服务暂不可用';
      console.error('[SearchService] query failed:', message);
      return {
        costTime: 0,
        errorDetail: message,
        query,
        resultNumbers: 0,
        results: [],
      };
    }
  }

  /**
   * Query for search results (uses the first provider)
   */
  async query(query: string, params?: SearchParams) {
    return this.queryWithImpl(this.searchImpList[0], query, params);
  }

  async webSearch({ query, searchCategories, searchEngines, searchTimeRange }: SearchQuery) {
    try {
      if (log.enabled) {
        log(
          'webSearch:start providers=%d q=%d c=%d e=%d mem=%s',
          this.searchImpList.length,
          query.length,
          searchCategories?.length || 0,
          searchEngines?.length || 0,
          getMemorySnapshot(),
        );
      }
    } catch {}

    // Records the first failed attempt (provider rejection or an impl-reported
    // errorDetail) so an incomplete search is distinguishable from a real empty one.
    let failureDetail: string | undefined;
    const recordFailure = (data: UniformSearchResponse) => {
      if (failureDetail === undefined && data.errorDetail) failureDetail = data.errorDetail;
    };

    for (const impl of this.searchImpList) {
      try {
        if (log.enabled) {
          log(
            'webSearch:impl impl=%s mem=%s',
            impl.constructor.name || 'UnknownSearchImpl',
            getMemorySnapshot(),
          );
        }
      } catch {}

      let data = await this.queryWithImpl(impl, query, {
        searchCategories,
        searchEngines,
        searchTimeRange,
      });
      recordFailure(data);

      // First retry: remove search engine restrictions if no results found
      if (data.results.length === 0 && searchEngines && searchEngines?.length > 0) {
        data = await this.queryWithImpl(impl, query, {
          searchCategories,
          searchEngines: undefined,
          searchTimeRange,
        });
        recordFailure(data);
      }

      // Second retry: remove all restrictions if still no results found
      if (data.results.length === 0) {
        data = await this.queryWithImpl(impl, query);
        recordFailure(data);
      }

      // If this provider returned results, use them
      if (data.results.length > 0) {
        return data;
      }
    }

    // No provider returned results. A fully legitimate empty result set stays
    // empty; an incomplete search (any failed attempt) must surface as a
    // controlled failure instead of a silent "success with no results".
    if (failureDetail !== undefined) {
      // Keep provider diagnostics out of this client-facing error.
      log('webSearch:incomplete cause=%s', failureDetail);
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: SEARCH_INCOMPLETE_MESSAGE,
      });
    }

    // All providers completed with zero results and no failures.
    return { costTime: 0, query, resultNumbers: 0, results: [] };
  }
}

// Add a default exported instance for convenience
export const searchService = new SearchService();
