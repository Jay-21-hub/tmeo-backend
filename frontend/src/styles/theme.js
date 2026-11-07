// JS mirror of tokens.css — use ONLY where a raw JS value is unavoidable
// (Recharts fills/strokes, Leaflet marker colors, canvas). Everywhere else,
// prefer the CSS classes/vars in components.css / tokens.css.

export const colors = {
  navy: { 950: '#060d1c', 900: '#0b1830', 800: '#102142', 700: '#16305c', 600: '#1c3d75', 500: '#274d8f' },
  blue: { 700: '#1d4ed8', 600: '#2563eb', 500: '#3b82f6', 100: '#dbeafe', 50: '#eff6ff' },
  slate: { 950: '#0f172a', 900: '#1e293b', 800: '#334155', 700: '#475569', 600: '#64748b', 500: '#94a3b8', 400: '#cbd5e1', 300: '#e2e8f0', 200: '#edf1f5', 100: '#f1f5f9', 50: '#f8fafc' },
  success: { 700: '#15803d', 600: '#16a34a', 500: '#22c55e', 100: '#dcfce7', 50: '#f0fdf4' },
  warning: { 700: '#b45309', 600: '#d97706', 500: '#f59e0b', 100: '#fef3c7', 50: '#fffbeb' },
  danger: { 700: '#b91c1c', 600: '#dc2626', 500: '#ef4444', 100: '#fee2e2', 50: '#fef2f2' },
  white: '#ffffff',
}

export const chartPalette = [colors.blue[600], colors.success[600], colors.warning[600], colors.danger[600], colors.navy[600], colors.slate[500]]

export const radius = { sm: 6, md: 8, lg: 12, xl: 16, full: 999 }

export const breakpoints = { mobile: 639, tablet: 1023 }