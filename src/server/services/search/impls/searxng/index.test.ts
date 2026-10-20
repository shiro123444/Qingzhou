// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SearXNGClient } from './client';
import { hetongxue } from './fixtures/searXNG';
import { SearXNGImpl } from './index';

const { mockToolsEnv } = vi.hoisted(() => ({
  mockToolsEnv: {
    SEARXNG_URL: 'https://demo.com',
  },
}));

vi.mock('@/envs/tools', () => ({
  toolsEnv: mockToolsEnv,
}));

describe('SearXNGImpl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockToolsEnv.SEARXNG_URL = 'https://demo.com';
  });

  describe('query', () => {
    it('搜索结果超过10个', async () => {
      vi.spyOn(SearXNGClient.prototype, 'search').mockResolvedValueOnce(hetongxue);

      const searchImpl = new SearXNGImpl();
      const results = await searchImpl.query('何同学');

      // Assert
      expect(results.results.length).toEqual(43);
    });

    it('合法200且无引擎故障时返回正常0结果', async () => {
      vi.spyOn(SearXNGClient.prototype, 'search').mockResolvedValueOnce({
        answers: [],
        corrections: [],
        infoboxes: [],
        number_of_results: 0,
        query: 'nonexistentquery12345',
        results: [],
        suggestions: [],
        unresponsive_engines: [],
      });

      const searchImpl = new SearXNGImpl();
      const results = await searchImpl.query('nonexistentquery12345');

      expect(results.results).toEqual([]);
      expect(results.resultNumbers).toBe(0);
    });

    it('部分引擎失败但有可用结果时应正常返回结果', async () => {
      vi.spyOn(SearXNGClient.prototype, 'search').mockResolvedValueOnce({
        answers: [],
        corrections: [],
        infoboxes: [],
        number_of_results: 1,
        query: 'TypeScript',
        results: [
          {
            category: 'general',
            content: 'TypeScript documentation',
            engine: 'bing',
            engines: ['bing'],
            parsed_url: ['https', 'www.typescriptlang.org', '', '', '', ''],
            positions: [1],
            score: 1,
            template: 'default.html',
            title: 'TypeScript',
            url: 'https://www.typescriptlang.org',
          },
        ],
        suggestions: [],
        unresponsive_engines: [
          ['duckduckgo', 'timeout'],
          ['google', 'CAPTCHA'],
        ],
      });

      const searchImpl = new SearXNGImpl();
      const results = await searchImpl.query('TypeScript');

      expect(results.results.length).toBe(1);
      expect(results.results[0].title).toBe('TypeScript');
      expect(results.results[0].parsedUrl).toBe('www.typescriptlang.org');
    });

    it('过滤坏URL和非http/https项目，保留合法项', async () => {
      vi.spyOn(SearXNGClient.prototype, 'search').mockResolvedValueOnce({
        answers: [],
        corrections: [],
        infoboxes: [],
        number_of_results: 3,
        query: 'mixed',
        results: [
          {
            category: 'general',
            content: 'good',
            engine: 'test',
            engines: ['test'],
            parsed_url: [],
            positions: [1],
            score: 1,
            template: '',
            title: 'Good item',
            url: 'https://example.com/good',
          },
          {
            category: '',
            content: undefined,
            engine: 'test',
            engines: undefined as any,
            parsed_url: [],
            positions: [2],
            score: 0,
            template: '',
            title: 'Broken URL item',
            url: 'not-a-valid-url',
          },
          {
            category: '',
            content: undefined,
            engine: 'test',
            engines: undefined as any,
            parsed_url: [],
            positions: [3],
            score: 0,
            template: '',
            title: 'FTP item',
            url: 'ftp://example.com/file',
          },
        ],
        suggestions: [],
        unresponsive_engines: [],
      });

      const searchImpl = new SearXNGImpl();
      const results = await searchImpl.query('mixed');

      expect(results.results.length).toBe(1);
      expect(results.results[0].title).toBe('Good item');
      expect(results.results[0].url).toBe('https://example.com/good');
      expect(results.results[0].parsedUrl).toBe('example.com');
    });

    it('无显式引擎且结果为空但有引擎失败时，应受控报 SEARCH_INCOMPLETE', async () => {
      vi.spyOn(SearXNGClient.prototype, 'search').mockResolvedValueOnce({
        answers: [],
        corrections: [],
        infoboxes: [],
        number_of_results: 0,
        query: 'Cordis official website',
        results: [],
        suggestions: [],
        unresponsive_engines: [
          ['google', 'Suspended: CAPTCHA'],
          ['brave', 'timeout'],
        ],
      });

      const searchImpl = new SearXNGImpl();

      await expect(searchImpl.query('Cordis official website')).rejects.toThrowError(
        expect.objectContaining({
          code: 'SERVICE_UNAVAILABLE',
          message: expect.stringMatching(/SEARCH_INCOMPLETE: 检索不完整，请重试/),
        }),
      );
    });

    it('显式指定引擎且全部指定引擎失败时，应受控报 SERVICE_UNAVAILABLE', async () => {
      vi.spyOn(SearXNGClient.prototype, 'search').mockResolvedValueOnce({
        answers: [],
        corrections: [],
        infoboxes: [],
        number_of_results: 0,
        query: 'test',
        results: [],
        suggestions: [],
        unresponsive_engines: [
          ['google', 'Suspended: CAPTCHA'],
          ['bing', 'timeout'],
        ],
      });

      const searchImpl = new SearXNGImpl();

      await expect(
        searchImpl.query('test', { searchEngines: ['google', 'bing'] }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'SERVICE_UNAVAILABLE',
          message: expect.stringContaining('所有指定搜索引擎均失败: google, bing'),
        }),
      );
    });

    it('显式指定引擎但部分失败且结果为0时统一报 SEARCH_INCOMPLETE', async () => {
      vi.spyOn(SearXNGClient.prototype, 'search').mockResolvedValueOnce({
        answers: [],
        corrections: [],
        infoboxes: [],
        number_of_results: 0,
        query: 'test',
        results: [],
        suggestions: [],
        unresponsive_engines: [['google', 'Suspended: CAPTCHA']],
      });

      const searchImpl = new SearXNGImpl();

      await expect(
        searchImpl.query('test', {
          searchEngines: ['google', 'wikipedia'],
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'SERVICE_UNAVAILABLE',
          message: 'SEARCH_INCOMPLETE: 检索不完整，请重试',
        }),
      );
    });

    it('未配置 SEARXNG_URL 时抛出 NOT_IMPLEMENTED', async () => {
      mockToolsEnv.SEARXNG_URL = '';

      const searchImpl = new SearXNGImpl();

      await expect(searchImpl.query('test')).rejects.toThrowError(
        expect.objectContaining({
          code: 'NOT_IMPLEMENTED',
        }),
      );
    });

    it('底座 HTTP 错误时应转为固定搜索服务暂不可用错误', async () => {
      vi.spyOn(SearXNGClient.prototype, 'search').mockRejectedValueOnce(
        new Error('Failed to search: HTTP 500'),
      );

      const searchImpl = new SearXNGImpl();

      await expect(searchImpl.query('test')).rejects.toThrowError(
        expect.objectContaining({
          code: 'SERVICE_UNAVAILABLE',
          message: '搜索服务暂不可用',
        }),
      );
    });
  });
});
