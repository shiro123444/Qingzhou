import { describe, expect, it } from 'vitest';

import { approvedPointSeries, updateChartNarration } from './approved-point-series';

describe('approved numeric correspondences', () => {
  it.each([
    [
      '横向位置为 -3、-1、2，对应幅值为 10、6、4',
      [
        [-3, 10],
        [-1, 6],
        [2, 4],
      ],
    ],
    [
      'Times 0, 0.5, 2 correspond to amplitudes 2e-2, 3e-2, 4e-2',
      [
        [0, 0.02],
        [0.5, 0.03],
        [2, 0.04],
      ],
    ],
  ])('preserves explicit source pairs across topics: %s', (source, expected) => {
    expect(approvedPointSeries([source as string])).toEqual(expected);
  });
  it('refuses mismatched, unrelated or ambiguous lists', () => {
    expect(approvedPointSeries(['位置1、2、3，对应强度4、5'])).toBeUndefined();
    expect(approvedPointSeries(['甲组1、2；乙组3、4'])).toBeUndefined();
    expect(approvedPointSeries(['位置1、2对应幅度3、4', '位置5、6对应幅度7、8'])).toBeUndefined();
    expect(approvedPointSeries(['函数 f(x)=x^2，另取1、2、3作说明'])).toBeUndefined();
  });
});

it('tracks named source values and their consecutive differences in presenter notes', () => {
  const original: [number, number][][] = [
    [
      [1, 8],
      [2, 12],
      [3, 16],
      [4, 19],
      [5, 22],
    ],
  ];
  const changed: [number, number][][] = [
    [
      [1, 8],
      [2, 12],
      [3, 17],
      [4, 19],
      [5, 22],
    ],
  ];
  expect(
    updateChartNarration(
      '对应响应依次为8、12、16、19、22。逐级增量依次为4、4、3、3。其他项为4、4、3、3。',
      original,
      changed,
      ['载荷 F', '响应 S'],
    ),
  ).toBe('对应响应依次为8、12、17、19、22。逐级增量依次为4、5、2、3。其他项为4、4、3、3。');
});
