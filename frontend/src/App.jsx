import { Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/auth/LoginPage'
import AdminDashboard from './pages/admin/AdminDashboard'
import StaffDashboard from './pages/staff/StaffDashboard'
import EnforcerDashboard from './pages/enforcer/EnforcerDashboard'
import ResetPassword from './pages/ResetPassword'
import PublicLayout from './pages/public/PublicLayout'
import HomePage from './pages/public/HomePage'
import AboutPage from './pages/public/AboutPage'
import MissionVisionPage from './pages/public/MissionVisionPage'
import ViolationUpdatesPage from './pages/public/ViolationUpdatesPage'
import ContactPage from './pages/public/ContactPage'
import { clearAuthSession } from './utils/session'

function PrivateRoute({ children, role }) {
  const token = localStorage.getItem('access_token')
  let user = {}
  try {
    user = JSON.parse(localStorage.getItem('user') || '{}')
  } catch {
    clearAuthSession()
    return <Navigate to="/login" />
  }
  if (!token) return <Navigate to="/login" />
  if (role && user.role !== role) return <Navigate to="/login" />
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<PublicLayout />}>
        <Route index element={<HomePage />} />
        <Route path="about" element={<AboutPage />} />
        <Route path="mission-vision" element={<MissionVisionPage />} />
        <Route path="violation-updates" element={<ViolationUpdatesPage />} />
        <Route path="contact" element={<ContactPage />} />
      </Route>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/reset-password/:uid/:token" element={<ResetPassword />} />
      <Route path="/admin/*" element={
        <PrivateRoute role="admin"><AdminDashboard /></PrivateRoute>
      } />
      <Route path="/staff/*" element={
        <PrivateRoute role="staff"><StaffDashboard /></PrivateRoute>
      } />
      <Route path="/enforcer/*" element={
        <PrivateRoute role="enforcer"><EnforcerDashboard /></PrivateRoute>
      } />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  )
}