import axios from 'axios'

const BASE = import.meta.env.VITE_API_URL

const publicApi = axios.create({ baseURL: BASE })

export function fetchPublicViolations(params = {}) {
  return publicApi.get('/api/violations/public/', { params }).then((res) => res.data)
}

export function fetchPublicStats() {
  return publicApi.get('/api/violations/public/stats/').then((res) => res.data)
}

export function fetchPublicViolationTypes() {
  return publicApi.get('/api/violations/public/types/').then((res) => res.data)
}

export default publicApi