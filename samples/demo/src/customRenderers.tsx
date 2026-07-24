// Custom-node escape hatch (NodeKind.Custom).
//
// A host registers a React component against a `moduleId`/`componentId` pair on
// a per-instance registry; `fuaran.custom({ moduleId, componentId, props })`
// nodes carrying that pair dispatch to it. This mirrors the F# tier's
// `IFuaranRuntime.RegisterCustomRenderer` bounded-escape seam — the typed tree
// stays closed, and anything outside the vocabulary routes through this one
// audited boundary.

import type { ReactElement } from 'react';

import type { JsonValue } from '@fuaran-ui/schema';
import { type CustomRendererProps, createCustomRendererRegistry } from '@fuaran-ui/renderer';

export const CHART_MODULE = 'demo';
export const CHART_COMPONENT = 'inline-chart';

const readNumberSeries = (value: JsonValue | undefined): number[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is number => typeof v === 'number');
};

const readString = (value: JsonValue | undefined, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

/** A registered Custom component: a tiny inline bar chart drawn as a placeholder SVG. */
function InlineChart({ props }: CustomRendererProps): ReactElement {
  const series = readNumberSeries(props['series']);
  const title = readString(props['title'], 'Inline chart');
  const max = series.length > 0 ? Math.max(...series, 1) : 1;
  const barWidth = 28;
  const gap = 10;
  const height = 80;
  const width = Math.max(series.length * (barWidth + gap) + gap, 120);

  return (
    <figure className="demo-inline-chart" aria-label={title}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-hidden="true"
      >
        {series.map((v, i) => {
          const barHeight = Math.round((v / max) * (height - 16));
          return (
            <rect
              key={i}
              x={gap + i * (barWidth + gap)}
              y={height - barHeight - 4}
              width={barWidth}
              height={barHeight}
              rx={3}
              fill="var(--demo-accent, #6366f1)"
            />
          );
        })}
      </svg>
      <figcaption>
        {title} — rendered by a host-registered Custom component ({CHART_MODULE}.{CHART_COMPONENT})
      </figcaption>
    </figure>
  );
}

/** Build a per-instance registry wired with the demo's Custom component(s). */
export const buildRegistry = (): ReturnType<typeof createCustomRendererRegistry> =>
  createCustomRendererRegistry().register(CHART_MODULE, CHART_COMPONENT, InlineChart);
