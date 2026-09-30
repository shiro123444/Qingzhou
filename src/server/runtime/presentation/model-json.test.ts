import { describe, expect, it } from 'vitest';

import { balancedJsonCandidates, extractModelJson, repairModelJson } from './model-json';

/** Verbatim shape that broke the live run: JavaScript-style bare keys. */
const javascriptFlavouredContent =
  '{"slides":[{"slideId":"slide-1","claim":"最优化理论与算法全局知识图谱","formulas":[{"id":"formula-1","latex":"\\\\nabla f(x^*)","explanation":"KKT 条件","fontSize":28,"placement":"slide"}],"visualKind":"scientific-diagram","visualReason":"结构化呈现理论演化脉络","visuals":[{"id":"visual-1","kind":"scientific-diagram",renderer:"image",fidelity:"conceptual",brief":"二维学术演化知识树状架构图。","required":true}]}]}';

describe('model JSON repair', () => {
  it('repairs bare keys emitted as JavaScript object literals', () => {
    expect(extractModelJson(javascriptFlavouredContent)).toEqual({
      slides: [
        {
          claim: '最优化理论与算法全局知识图谱',
          formulas: [
            {
              explanation: 'KKT 条件',
              fontSize: 28,
              id: 'formula-1',
              latex: '\\nabla f(x^*)',
              placement: 'slide',
            },
          ],
          slideId: 'slide-1',
          visualKind: 'scientific-diagram',
          visualReason: '结构化呈现理论演化脉络',
          visuals: [
            {
              brief: '二维学术演化知识树状架构图。',
              fidelity: 'conceptual',
              id: 'visual-1',
              kind: 'scientific-diagram',
              renderer: 'image',
              required: true,
            },
          ],
        },
      ],
    });
  });

  it('repairs single quotes, Python literals, comments and trailing commas', () => {
    const content = `{
      // a note the model added
      'slides': [
        {'slideId': 'slide-1', 'claim': 'demo', "required": True, "cancelled": None,},
      ],
      /* block comment */
      "count": 2,
    }`;
    expect(extractModelJson(content)).toEqual({
      count: 2,
      slides: [{ cancelled: null, claim: 'demo', required: true, slideId: 'slide-1' }],
    });
  });

  it('keeps real JSON literals as literals while quoting other bare words', () => {
    expect(extractModelJson('{required:true,disabled:false,reason:null,renderer:image}')).toEqual({
      disabled: false,
      reason: null,
      renderer: 'image',
      required: true,
    });
  });

  it('never rewrites text inside string values', () => {
    const value = {
      brief: 'renderer:image, {a:1}, [x], don\'t, {"b":2} // not a comment',
      latex: '\\frac{d}{dt} f(x) = \\sum_i \\alpha_i',
    };
    expect(extractModelJson(JSON.stringify(value))).toEqual(value);
    expect(extractModelJson(repairModelJson(JSON.stringify(value)))).toEqual(value);
  });

  it('escapes raw control characters that are invalid inside JSON strings', () => {
    expect(extractModelJson('{"brief":"line one\nline two","id":"visual-1"}')).toEqual({
      brief: 'line one\nline two',
      id: 'visual-1',
    });
  });

  it('keeps truncated output invalid instead of fabricating closers', () => {
    expect(() => extractModelJson('{"slides":[{"slideId":"slide-1","claim":"cut off')).toThrow(
      SyntaxError,
    );
  });

  it('reports prose-only answers as invalid JSON', () => {
    expect(() => extractModelJson('I cannot help with that request.')).toThrow(/valid JSON/u);
  });
});

describe('balanced JSON candidates', () => {
  it('lists nested spans in appearance order', () => {
    expect(balancedJsonCandidates('Notes then {"a":{"b":1}} and [1,2]')).toEqual([
      '{"a":{"b":1}}',
      '[1,2]',
    ]);
  });

  it('ignores braces and brackets that only appear inside quoted values', () => {
    expect(balancedJsonCandidates('prefix {"brief":"a } brace and [1]","n":1} suffix')).toEqual([
      '{"brief":"a } brace and [1]","n":1}',
    ]);
  });

  it('prefers the payload object over prose brackets that also parse', () => {
    expect(extractModelJson('Notes [1] about {template} then {"a":1}')).toEqual({ a: 1 });
  });
});
