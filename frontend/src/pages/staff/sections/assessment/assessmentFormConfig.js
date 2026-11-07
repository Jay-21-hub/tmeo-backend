export const formatDate = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const formatTime = () => {
  const d = new Date()
  let h = d.getHours()
  const min = String(d.getMinutes()).padStart(2, '0')
  const ampm = h >= 12 ? 'pm' : 'am'
  h = h % 12 || 12
  return `${String(h).padStart(2, '0')}:${min} ${ampm}`
}
export const getUser = () => {
  try {
    const u = JSON.parse(localStorage.getItem('user') || '{}')
    return u.full_name || u.name || u.username || 'Assessment Staff'
  } catch { return 'Assessment Staff' }
}
export const formatCurrency = (val) => {
  const n = parseFloat(val)
  if (isNaN(n)) return '—'
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}