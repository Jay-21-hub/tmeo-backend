from django.urls import path
from rest_framework_simplejwt.views import TokenRefreshView
from . import views

urlpatterns = [
    # Auth
    path('login/',           views.LoginView.as_view(),          name='login'),
    path('logout/',          views.LogoutView.as_view(),         name='logout'),
    path('token/refresh/',   TokenRefreshView.as_view(),         name='token_refresh'),

    # Password
    path('forgot-password/', views.ForgotPasswordView.as_view(), name='forgot_password'),
    path('reset-password/',  views.ResetPasswordView.as_view(),  name='reset_password'),
    path('change-password/', views.ChangePasswordView.as_view(), name='change_password'),

    # Current user
    path('me/',              views.MeView.as_view(),             name='me'),

    # Admin — user management
    path('users/',           views.UserListView.as_view(),       name='user_list'),
    path('users/<int:pk>/',  views.UserDetailView.as_view(),     name='user_detail'),

    # Enforcer — duty status
    path('duty-status/',     views.UpdateDutyStatusView.as_view(), name='duty_status'),

    # FCM Push Notifications
    path('fcm-token/',       views.UpdateFCMTokenView.as_view(),  name='fcm_token'),
]