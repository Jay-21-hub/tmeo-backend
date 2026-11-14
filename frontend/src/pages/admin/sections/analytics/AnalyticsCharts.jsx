import {
  BarChart, Bar, PieChart, Pie, Cell, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import {
  AXIS_TICK, GRID_STROKE, AGING_COLORS, PAYMENT_COLORS, WEEKDAY_SHORT, hourShort, hourRange, peso,
} from './analyticsConfig'
import { ChartTooltip, RichTooltip } from './AnalyticsPrimitives'
import { OTHERS_KEY, stackedMix, rowFromChartEvent } from './analyticsUtils'

const ACTIVE_COLOR = '#1D4ED8'
const BASE_COLOR = '#60A5FA'
const DIM_COLOR = '#BFDBFE'

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))

/* ─── Trend (area) ─────────────────────────────────────────── */
const asRows = (value) => (Array.isArray(value) ? value : [])

export function TrendChart({ data, onSelect, height = 240 }) {
  const rows = asRows(data)
  const showDots = rows.length <= 31
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart
        data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
        onClick={(state) => { const row = rowFromChartEvent(rows, state); if (row) onSelect?.(row) }}
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
  const rows = asRows(data)
  const anyActive = isActive ? rows.some(isActive) : false
  return (
    <div style={{ position: 'relative', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={rows} dataKey="count" nameKey="status" cx="50%" cy="50%"
            innerRadius="58%" outerRadius="82%" paddingAngle={2} stroke="none"
            onClick={(_, i) => onSelect?.(rows[i])} style={{ cursor: onSelect ? 'pointer' : 'default' }}
          >
            {rows.map((d, i) => {
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
  const rows = asRows(data)
  const anyActive = isActive ? rows.some(isActive) : false
  const height = Math.max(120, rows.length * rowHeight + 24)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 28, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={GRID_STROKE} />
        <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <YAxis
          type="category" dataKey="name" width={nameWidth} tickLine={false} axisLine={false}
          tick={{ fontSize: 12, fill: '#374151' }} tickFormatter={(v) => clip(v, Math.floor(nameWidth / 6.5))}
        />
        <Tooltip content={<RichTooltip extra={extra} title={(r) => r?.name} />} cursor={{ fill: 'rgba(37,99,235,0.06)' }} />
        <Bar
          dataKey="count" name={valueName} radius={[0, 6, 6, 0]} maxBarSize={22}
          onClick={(_, i) => onSelect?.(rows[i])} style={{ cursor: onSelect ? 'pointer' : 'default' }}
          label={{ position: 'right', fontSize: 11, fill: '#6B7280' }}
        >
          {rows.map((r, i) => (
            <Cell key={`${r.name}-${i}`} fill={anyActive ? (isActive(r) ? ACTIVE_COLOR : DIM_COLOR) : color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function MixTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  if (!row) return null
  const parts = payload.filter((p) => Number(p.value) > 0)
  return (
    <div style={{ background: 'var(--navy-900)', borderRadius: 'var(--radius-md)', padding: '10px 14px', boxShadow: 'var(--shadow-lg)', maxWidth: 280 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 4 }}>{row.name}</div>
      {parts.map((p) => (
        <div key={p.dataKey} style={{ fontSize: 12, color: '#fff', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: p.color || '#fff' }}>{p.name}</span>
          <span style={{ fontWeight: 700 }}>{Number(p.value).toLocaleString()}</span>
        </div>
      ))}
      <div style={{ fontSize: 11, color: 'var(--slate-300)', marginTop: 6 }}>Total: {Number(row.total || 0).toLocaleString()}</div>
    </div>
  )
}

/* ─── Stacked mix (vehicle or location × violation type) ──── */
/* Built from the existing crosstab matrix: top 8 rows, top 5 types, rest as Others. */
export function StackedMixChart({ crosstab, colors = {}, isRowActive, activeType, onSelectSegment, onSelectRow, onSelectType }) {
  const mix = stackedMix(crosstab)
  const rows = mix.rows
  if (!rows.length) return null
  const keys = [
    ...mix.typeNames.filter((name) => rows.some((r) => r.segments.some((s) => s.name === name && s.count > 0))),
    ...(rows.some((r) => r.others > 0) ? [OTHERS_KEY] : []),
  ]
  const data = rows.map((r) => {
    const row = { name: r.label, total: r.total, _segments: {} }
    r.segments.forEach((s) => {
      row[s.name] = s.count
      row._segments[s.name] = s
    })
    row[OTHERS_KEY] = r.others
    return row
  })
  const anyRow = isRowActive ? data.some((r) => isRowActive(r.name)) : false
  const anyType = !!(activeType && mix.typeNames.some((name) => mix.typeCodes[name] === activeType))
  const dimmed = (label, name) => {
    const rowMatch = !anyRow || isRowActive(label)
    const typeMatch = !anyType || (name !== OTHERS_KEY && mix.typeCodes[name] === activeType)
    return !(rowMatch && typeMatch)
  }
  const height = Math.max(160, data.length * 36 + 36)
  const renderTick = (props) => {
    const { x, y, payload } = props
    const full = payload?.value ?? ''
    const selected = isRowActive?.(full)
    return (
      <g transform={`translate(${x},${y})`}>
        <title>{full}</title>
        <text
          x={0} y={0} dy={4} textAnchor="end"
          fill={selected ? '#1D4ED8' : '#374151'}
          fontSize={12} fontWeight={selected ? 700 : 500}
          style={{ cursor: onSelectRow ? 'pointer' : 'default' }}
          onClick={() => onSelectRow?.(full)}
        >{clip(full, 18)}</text>
      </g>
    )
  }
  return (
    <div data-scroll-x style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: 520, height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={GRID_STROKE} />
            <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
            <YAxis type="category" dataKey="name" width={132} tickLine={false} axisLine={false} tick={renderTick} />
            <Tooltip content={<MixTooltip />} cursor={{ fill: 'rgba(37,99,235,0.06)' }} />
            <Legend
              wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
              onClick={(item) => {
                const name = item?.dataKey
                if (!name || name === OTHERS_KEY) return
                const code = mix.typeCodes[name]
                if (code) onSelectType?.({ code, name })
              }}
            />
            {keys.map((name) => (
              <Bar
                key={name} dataKey={name} name={name} stackId="mix" fill={colors[name] || '#94A3B8'} maxBarSize={18}
                style={{ cursor: name === OTHERS_KEY || !onSelectSegment ? 'default' : 'pointer' }}
                onClick={(bar) => {
                  if (name === OTHERS_KEY) return
                  const row = bar?.payload || bar
                  const seg = row?._segments?.[name]
                  if (!seg?.code || !Number(row?.[name])) return
                  onSelectSegment?.(seg, { label: row.name })
                }}
              >
                {data.map((row) => {
                  const selected = isRowActive?.(row.name) && name !== OTHERS_KEY && mix.typeCodes[name] === activeType
                  return (
                    <Cell
                      key={`${row.name}-${name}`}
                      fill={colors[name] || '#94A3B8'}
                      fillOpacity={dimmed(row.name, name) ? 0.28 : 1}
                      stroke={selected ? '#0F172A' : 'none'}
                      strokeWidth={selected ? 2 : 0}
                    />
                  )
                })}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

/* ─── Peak hours (24 columns) ───────────────────────────────── */
export function PeakHoursChart({ data, activeHour, onSelect, height = 220 }) {
  const rows = asRows(data)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="hour" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={2} tickFormatter={hourShort} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip content={<RichTooltip title={(r) => r?.label} />} cursor={{ fill: 'rgba(37,99,235,0.06)' }} />
        <Bar dataKey="count" name="Violations" radius={[4, 4, 0, 0]} onClick={(_, i) => onSelect?.(rows[i])} style={{ cursor: 'pointer' }}>
          {rows.map((d, i) => (
            <Cell
              key={d?.hour ?? i}
              fill={activeHour === d?.hour ? ACTIVE_COLOR : activeHour !== null && activeHour !== undefined ? DIM_COLOR : BASE_COLOR}
              stroke={activeHour === d?.hour ? '#0F172A' : 'none'} strokeWidth={activeHour === d?.hour ? 2 : 0}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ─── Weekday (7 columns, Mon–Sun) ──────────────────────────── */
export function WeekdayChart({ data, activeWeekday, onSelect, height = 220 }) {
  const rows = asRows(data).map(d => ({ ...d, short: WEEKDAY_SHORT[(d?.weekday || 1) - 1] }))
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
  const slots = (Array.isArray(heatmap?.cells) ? heatmap.cells : [])
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
  const rows = asRows(buckets)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip content={<RichTooltip title={(r) => `Paid in ${r?.label}`} extra={() => ['Paid violations only']} />} cursor={{ fill: 'rgba(37,99,235,0.06)' }} />
        <Bar dataKey="count" name="Paid violations" radius={[4, 4, 0, 0]} maxBarSize={56} label={{ position: 'top', fontSize: 11, fill: '#6B7280' }}>
          {rows.map((b, i) => <Cell key={b?.key ?? i} fill={PAYMENT_COLORS[i % PAYMENT_COLORS.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ─── Outstanding aging (neutral age buckets) ───────────────── */
export function AgingChart({ buckets, height = 220 }) {
  const rows = asRows(buckets)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip content={<RichTooltip title={(r) => `Unpaid for ${r?.label}`} extra={(r) => [`Outstanding: ${peso(r.amount)}`]} />} cursor={{ fill: 'rgba(37,99,235,0.06)' }} />
        <Bar dataKey="count" name="Unpaid violations" radius={[4, 4, 0, 0]} maxBarSize={56} label={{ position: 'top', fontSize: 11, fill: '#6B7280' }}>
          {rows.map((b, i) => <Cell key={b?.key ?? i} fill={AGING_COLORS[i % AGING_COLORS.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ─── Repeat-offender distribution (2 / 3 / 4+) ─────────────── */
export function RepeatDistributionChart({ distribution, height = 160 }) {
  const rows = asRows(distribution)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip content={<RichTooltip title={(r) => r?.label} />} cursor={{ fill: 'rgba(220,38,38,0.06)' }} />
        <Bar dataKey="violators" name="Violators" fill="#F87171" radius={[4, 4, 0, 0]} maxBarSize={48} label={{ position: 'top', fontSize: 11, fill: '#6B7280' }} />
      </BarChart>
    </ResponsiveContainer>
  )
}