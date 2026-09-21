import type { VegaEmbedProps } from 'react-vega'
import { graphColor } from './graph'
import type { ThemeColors } from './tokenReader'

/** An authored palette is content, including expressions, conditional encodings,
 * schemes, null/transparent fills, config and named styles. Opt out as a whole:
 * mixing theme defaults with a partial authored palette can destroy its contrast.
 * Data values are not rendering directives. Never rewrite the supplied spec.
 */
export function hasAuthoredChartColors(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasAuthoredChartColors)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => {
    if (['data', 'datasets', 'values'].includes(key)) return false
    // A typed field encoding selects a default scale, not an authored palette.
    if (
      ['color', 'fill', 'stroke'].includes(key) &&
      child &&
      typeof child === 'object' &&
      'field' in child &&
      'type' in child &&
      !('value' in child) &&
      !('condition' in child)
    ) {
      return hasAuthoredChartColors(child)
    }
    if (/^(?:color|fill|stroke|background|scheme|range)$|Color$/.test(key)) return true
    return hasAuthoredChartColors(child)
  })
}

type ChartConfig = NonNullable<NonNullable<VegaEmbedProps['options']>['config']>

/** Lowest-priority Vega/Vega-Lite defaults, never data/encoding replacements. */
export function chartThemeConfig(spec: Record<string, unknown>, colors: ThemeColors): ChartConfig | undefined {
  if (hasAuthoredChartColors(spec)) return undefined
  const chartColor = (slot: string) => graphColor(colors, `--graph-chart-${slot}`)
  const fg = chartColor('fg')
  const mark = chartColor('mark')
  const grid = chartColor('grid')
  const config = {
    axis: {
      domainColor: chartColor('axis'),
      tickColor: chartColor('axis'),
      gridColor: grid,
      labelColor: fg,
      titleColor: fg,
    },
    legend: { labelColor: fg, titleColor: fg, gradientStrokeColor: grid, symbolBaseStrokeColor: chartColor('axis') },
    title: { color: fg, subtitleColor: fg },
    range: { category: Array.from({ length: 10 }, (_, i) => chartColor(`category-${i + 1}`)) },
  }
  const lite =
    typeof spec.$schema === 'string'
      ? spec.$schema.includes('vega-lite')
      : ['mark', 'layer', 'facet', 'repeat', 'concat', 'hconcat', 'vconcat'].some((key) => key in spec)
  if (lite) {
    return {
      ...config,
      background: chartColor('bg'),
      mark: { color: mark },
      rule: { color: fg },
      text: { color: fg },
      view: { stroke: grid },
      boxplot: { median: { color: chartColor('bg') } },
    }
  }
  return {
    ...config,
    // Vega (unlike Vega-Lite) defaults to no background. Keep transparency.
    arc: { fill: mark },
    area: { fill: mark },
    rect: { fill: mark },
    line: { stroke: mark },
    path: { stroke: mark },
    shape: { stroke: mark },
    symbol: { fill: mark },
    trail: { fill: mark },
    rule: { stroke: fg },
    text: { fill: fg },
    style: {
      'guide-label': { fill: fg },
      'guide-title': { fill: fg },
      'group-title': { fill: fg },
      'group-subtitle': { fill: fg },
      cell: { stroke: grid },
    },
  }
}
