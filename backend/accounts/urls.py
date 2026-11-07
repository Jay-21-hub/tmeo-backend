from django.urls import path
from .token_views import TMEOTokenRefreshView
from . import views

urlpatterns = [
    # Auth
    path('login/',           views.LoginView.as_view(),          name='login'),
    path('logout/',          views.LogoutView.as_view(),         name='logout'),
    path('token/refresh/',   TMEOTokenRefreshView.as_view(),     name='token_refresh'),

    # Password
    path('forgot-password/', views.ForgotPasswordView.as_view(), name='forgot_password'),
    path('reset-password/',  views.ResetPasswordView.as_view(),  name='reset_password'),
    path('change-password/', views.ChangePasswordView.as_view(), name='change_password'),

    # Current user
    path('me/',              views.MeView.as_view(),             name='me'),

    # Admin — user management
    path('users/',                            views.UserListView.as_view(),              name='user_list'),
    path('users/<int:pk>/',                   views.UserDetailView.as_view(),            name='user_detail'),
    path('users/<int:pk>/reset-password/',    views.AdminResetPasswordView.as_view(),    name='admin_reset_password'),
    path('users/<int:pk>/permanent/',         views.PermanentDeleteUserView.as_view(),   name='user_permanent_delete'),
    path('users/<int:pk>/change-role/',       views.ChangeUserRoleView.as_view(),        name='user_change_role'),

    # Enforcer — duty status
    path('duty-status/',     views.UpdateDutyStatusView.as_view(), name='duty_status'),

    # FCM Push Notifications
    path('fcm-token/',       views.UpdateFCMTokenView.as_view(),  name='fcm_token'),
]