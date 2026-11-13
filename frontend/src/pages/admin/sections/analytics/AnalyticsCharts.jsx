import {
  BarChart, Bar, PieChart, Pie, Cell, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import {
  AXIS_TICK, GRID_STROKE, CHART_PALETTE, AGING_COLORS, PAYMENT_COLORS, WEEKDAY_SHORT, hourShort, hourRange, peso,
} from './analyticsConfig'
import { ChartTooltip, RichTooltip } from './AnalyticsPrimitives'
import { rowFromChartEvent } from './analyticsUtils'

const ACTIVE_COLOR = '#1D4ED8'
const BASE_COLOR = '#60A5FA'
const DIM_COLOR = '#BFDBFE'

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))

/* ─── Trend (area) ─────────────────────────────────────────── */
export function TrendChart({ data, onSelect, height = 240 }) {
  const showDots = data.length <= 31
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart
        data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
        onClick={(state) => { const row = rowFromChartEvent(data, state); if (row) onSelect?.(row) }}
        style={{ cursor: onSelect ? 'pointer' : 'default' }}
      >
        <defs>
          <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#2563EB" stopOpacity={0.18} />
            <stop offset="95%" stopColor="#2563EB" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip content={<ChartTooltip />} />
        <Area
          type="monotone" dataKey="count" name="Violations" stroke="#2563EB" strokeWidth={2.5} fill="url(#trendGrad)"
          dot={showDots ? { r: 3.5, fill: '#2563EB' } : false} activeDot={{ r: 6, fill: '#2563EB' }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/* ─── Donut (part-to-whole, few categories) ────────────────── */
export function DonutChart({ data, colorFor, centerValue, centerLabel, onSelect, isActive, height = 200 }) {
  const anyActive = isActive ? data.some(isActive) : false
  return (
    <div style={{ position: 'relative', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data} dataKey="count" nameKey="status" cx="50%" cy="50%"
            innerRadius="58%" outerRadius="82%" paddingAngle={2} stroke="none"
            onClick={(_, i) => onSelect?.(data[i])} style={{ cursor: onSelect ? 'pointer' : 'default' }}
          >
            {data.map((d, i) => {
              const selected = anyActive && isActive(d)
              return (
                <Cell
                  key={d.status} fill={colorFor(d, i)}
                  fillOpacity={anyActive && !selected ? 0.25 : 1}
                  stroke={selected ? '#0F172A' : 'none'} strokeWidth={selected ? 2 : 0}
                />
              )
            })}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--slate-950)' }}>{centerValue}</span>
        <span className="text-caption">{centerLabel}</span>
      </div>
    </div>
  )
}

/* ─── Ranked horizontal bars (categories with long names) ──── */
/* data rows need `name` and `count`; `isActive(row)` highlights the selected one. */
export function RankedBarChart({ data, onSelect, isActive, valueName = 'Violations', extra, rowHeight = 34, nameWidth = 150, color = BASE_COLOR }) {
  const anyActive = isActive ? data.some(isActive) : false
  const height = Math.max(120, data.length * rowHeight + 24)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 28, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={GRID_STROKE} />
        <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <YAxis
          type="category" dataKey="name" width={nameWidth} tickLine={false} axisLine={false}
          tick={{ fontSize: 12, fill: '#374151' }} tickFormatter={(v) => clip(v, Math.floor(nameWidth / 6.5))}
        />
        <Tooltip content={<RichTooltip extra={extra} title={(r) => r?.name} />} cursor={{ fill: 'rgba(37,99,235,0.06)' }} />
        <Bar
          dataKey="count" name={valueName} radius={[0, 6, 6, 0]} maxBarSize={22}
          onClick={(_, i) => onSelect?.(data[i])} style={{ cursor: onSelect ? 'pointer' : 'default' }}
          label={{ position: 'right', fontSize: 11, fill: '#6B7280' }}
        >
          {data.map((r, i) => (
            <Cell key={`${r.name}-${i}`} fill={anyActive ? (isActive(r) ? ACTIVE_COLOR : DIM_COLOR) : color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ─── Cross-tab matrix (heatmap table) ─────────────────────── */
/* crosstab = { rows:[{label,total,types:[{name,code,count}],other}], type_names, type_codes, has_other }
   A matrix stays readable with many violation types and small rows, where stacked bars need a
   colour per type (and similar hues become indistinguishable). Scrolls inside its own container. */
export function CrosstabMatrix({ crosstab, rowHeader = 'Row', isRowActive, activeType, onSelectCell, onSelectRow, onSelectType }) {
  const rows = crosstab?.rows || []
  const names = crosstab?.type_names || []
  const codes = crosstab?.type_codes || {}
  const cellOf = (r, n) => r.types.find(t => t.name === n)?.count || 0
  const max = Math.max(0, ...rows.flatMap(r => names.map(n => cellOf(r, n))))
  const anyRowActive = isRowActive ? rows.some(r => isRowActive(r.label)) : false
  const th = { fontSize: 10.5, fontWeight: 600, color: 'var(--slate-600)', padding: '4px 3px', textAlign: 'center', verticalAlign: 'bottom', lineHeight: 1.2 }
  const headBtn = (active) => ({ font: 'inherit', fontWeight: active ? 700 : 600, color: active ? 'var(--navy-900)' : 'inherit', background: active ? 'var(--blue-50)' : 'transparent', border: 'none', borderRadius: 4, padding: '2px 3px', cursor: 'pointer', width: '100%', wordBreak: 'normal', overflowWrap: 'normal' })

  return (
    <div data-scroll-x style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 2, width: '100%', minWidth: 120 + (names.length + 2) * 66, fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left', position: 'sticky', left: 0, background: 'var(--surface, #fff)', minWidth: 110 }}>{rowHeader}</th>
            {names.map(n => {
              const active = activeType && codes[n] === activeType
              return (
                <th key={n} style={th} scope="col">
                  <button type="button" title={`${n} — filter by this violation`} aria-pressed={!!active} onClick={() => onSelectType?.({ code: codes[n], name: n })} style={headBtn(active)}>{clip(n, 13)}</button>
                </th>
              )
            })}
            {crosstab?.has_other && <th style={{ ...th, color: 'var(--slate-400)' }} scope="col">Other types</th>}
            <th style={th} scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const rowActive = isRowActive ? isRowActive(r.label) : false
            const dim = anyRowActive && !rowActive
            return (
              <tr key={r.label} style={{ opacity: dim ? 0.45 : 1 }}>
                <th scope="row" style={{ textAlign: 'left', position: 'sticky', left: 0, background: 'var(--surface, #fff)', padding: 0 }}>
                  <button type="button" title={`${r.label} — filter by this ${rowHeader.toLowerCase()}`} aria-pressed={rowActive} onClick={() => onSelectRow?.(r.label)} style={{ ...headBtn(rowActive), textAlign: 'left', fontSize: 12, padding: '6px 6px' }}>{clip(r.label, 22)}</button>
                </th>
                {names.map(n => {
                  const v = cellOf(r, n)
                  const alpha = max > 0 && v > 0 ? 0.12 + 0.88 * (v / max) : 0
                  const selected = rowActive && activeType && codes[n] === activeType
                  const share = r.total ? ((v / r.total) * 100).toFixed(1) : '0.0'
                  return (
                    <td key={n} style={{ padding: 0 }}>
                      <button
                        type="button" disabled={v === 0}
                        onClick={() => onSelectCell?.({ code: codes[n], name: n }, r)}
                        title={`${r.label} × ${n}: ${v} violation${v !== 1 ? 's' : ''} (${share}% of this row)`}
                        aria-label={`${r.label}, ${n}: ${v} violations`} aria-pressed={!!selected}
                        style={{
                          width: '100%', height: 30, borderRadius: 4, cursor: v === 0 ? 'default' : 'pointer', font: 'inherit', fontSize: 11, fontWeight: 600,
                          border: selected ? '2px solid var(--navy-900)' : '1px solid var(--slate-100)',
                          background: v > 0 ? `rgba(37, 99, 235, ${alpha.toFixed(2)})` : 'var(--slate-50)',
                          color: alpha > 0.5 ? '#fff' : v > 0 ? 'var(--slate-900)' : 'var(--slate-300)',
                        }}
                      >{v > 0 ? v : '–'}</button>
                    </td>
                  )
                })}
                {crosstab?.has_other && <td style={{ textAlign: 'center', color: 'var(--slate-400)', fontSize: 11 }}>{r.other || '–'}</td>}
                <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--slate-900)', fontSize: 12 }}>{r.total}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ─── Peak hours (24 columns) ───────────────────────────────── */
export function PeakHoursChart({ data, activeHour, onSelect, height = 220 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="hour" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={2} tickFormatter={hourShort} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip content={<RichTooltip title={(r) => r?.label} />} cursor={{ fill: 'rgba(37,99,235,0.06)' }} />
        <Bar dataKey="count" name="Violations" radius={[4, 4, 0, 0]} onClick={(_, i) => onSelect?.(data[i])} style={{ cursor: 'pointer' }}>
          {data.map(d => (
            <Cell
              key={d.hour}
              fill={activeHour === d.hour ? ACTIVE_COLOR : activeHour !== null && activeHour !== undefined ? DIM_COLOR : BASE_COLOR}
              stroke={activeHour === d.hour ? '#0F172A' : 'none'} strokeWidth={activeHour === d.hour ? 2 : 0}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ─── Weekday (7 columns, Mon–Sun) ──────────────────────────── */
export function WeekdayChart({ data, activeWeekday, onSelect, height = 220 }) {
  const rows = data.map(d => ({ ...d, short: WEEKDAY_SHORT[d.weekday - 1] }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="short" tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip content={<RichTooltip title={(r) => r?.name} />} cursor={{ fill: 'rgba(37,99,235,0.06)' }} />
        <Bar dataKey="count" name="Violations" radius={[4, 4, 0, 0]} maxBarSize={44} onClick={(_, i) => onSelect?.(rows[i])} style={{ cursor: 'pointer' }}>
          {rows.map(d => (
            <Cell
              key={d.weekday}
              fill={activeWeekday === d.weekday ? ACTIVE_COLOR : activeWeekday ? DIM_COLOR : BASE_COLOR}
              stroke={activeWeekday === d.weekday ? '#0F172A' : 'none'} strokeWidth={activeWeekday === d.weekday ? 2 : 0}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ─── Busiest day-and-hour slots (replaces the day × hour grid) ─ */
export function BusiestSlotsChart({ heatmap, activeWeekday, activeHour, onSelect }) {
  const names = heatmap?.weekday_names || []
  const slots = (heatmap?.cells || [])
    .filter(c => c.count > 0)
    .sort((a, b) => b.count - a.count || a.weekday - b.weekday || a.hour - b.hour)
    .slice(0, 8)
    .map(c => ({
      name: `${names[c.weekday - 1] || WEEKDAY_SHORT[c.weekday - 1] || 'Day'} · ${hourRange(c.hour)}`,
      count: c.count,
      weekday: c.weekday,
      hour: c.hour,
    }))
  if (!slots.length) return null
  return (
    <RankedBarChart
      data={slots}
      nameWidth={196}
      isActive={(r) => r.weekday === activeWeekday && r.hour === activeHour}
      onSelect={(r) => r && onSelect?.(r.weekday, r.hour)}
      extra={() => ['Click to filter the page to this day and hour']}
    />
  )
}

/* ─── How long paid violations took to be paid ─────────────── */
export function PaymentDurationChart({ buckets, height = 220 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={buckets} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip content={<RichTooltip title={(r) => `Paid in ${r?.label}`} extra={() => ['Paid violations only']} />} cursor={{ fill: 'rgba(37,99,235,0.06)' }} />
        <Bar dataKey="count" name="Paid violations" radius={[4, 4, 0, 0]} maxBarSize={56} label={{ position: 'top', fontSize: 11, fill: '#6B7280' }}>
          {buckets.map((b, i) => <Cell key={b.key} fill={PAYMENT_COLORS[i % PAYMENT_COLORS.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ─── Outstanding aging (neutral age buckets) ───────────────── */
export function AgingChart({ buckets, height = 220 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={buckets} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip content={<RichTooltip title={(r) => `Unpaid for ${r?.label}`} extra={(r) => [`Outstanding: ${peso(r.amount)}`]} />} cursor={{ fill: 'rgba(37,99,235,0.06)' }} />
        <Bar dataKey="count" name="Unpaid violations" radius={[4, 4, 0, 0]} maxBarSize={56} label={{ position: 'top', fontSize: 11, fill: '#6B7280' }}>
          {buckets.map((b, i) => <Cell key={b.key} fill={AGING_COLORS[i % AGING_COLORS.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ─── Repeat-offender distribution (2 / 3 / 4+) ─────────────── */
export function RepeatDistributionChart({ distribution, height = 160 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={distribution} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip content={<RichTooltip title={(r) => r?.label} />} cursor={{ fill: 'rgba(220,38,38,0.06)' }} />
        <Bar dataKey="violators" name="Violators" fill="#F87171" radius={[4, 4, 0, 0]} maxBarSize={48} label={{ position: 'top', fontSize: 11, fill: '#6B7280' }} />
      </BarChart>
    </ResponsiveContainer>
  )
}