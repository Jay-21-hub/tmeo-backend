from django import forms
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.contrib.auth.forms import UserCreationForm
from .models import CustomUser, UserRoleHistory
from .history_guard import get_user_historical_references


class CustomUserCreationForm(UserCreationForm):
    """Admin 'add user' form. Creating an account may still set role / id_number
    by hand, but it may not claim an ID that is assigned or retired."""

    class Meta(UserCreationForm.Meta):
        model  = CustomUser
        fields = ('email', 'full_name', 'last_name', 'first_name', 'middle_name', 'id_number', 'role')

    def clean_id_number(self):
        id_number = self.cleaned_data['id_number']
        if CustomUser.objects.is_id_reserved(id_number):
            raise forms.ValidationError('This ID number is already assigned or has been retired and cannot be reused.')
        return id_number


@admin.register(CustomUser)
class CustomUserAdmin(BaseUserAdmin):
    # role / id_number / hired_year drive the role-based ID and the
    # historical identity ledger. Editing them here would bypass the
    # controlled role-change flow (and its UserRoleHistory row), so they are
    # read-only on EXISTING accounts. Creating a new account is unchanged.
    add_form = CustomUserCreationForm
    _identity_locked = ('role', 'id_number', 'hired_year')

    def get_readonly_fields(self, request, obj=None):
        readonly = list(super().get_readonly_fields(request, obj))
        if obj is not None:
            readonly += [f for f in self._identity_locked if f not in readonly]
        return readonly

    def has_delete_permission(self, request, obj=None):
        """HD-B (Phase 4): the Django admin may not bypass historical
        protection. An account with historical records cannot be deleted here
        either (database PROTECT also blocks it); deactivate instead."""
        if not super().has_delete_permission(request, obj):
            return False
        if obj is not None and get_user_historical_references(obj)['has_history']:
            return False
        return True

    list_display  = ['email', 'full_name', 'id_number', 'role', 'is_active', 'date_joined']
    list_filter   = ['role', 'is_active']
    search_fields = ['email', 'full_name', 'last_name', 'first_name', 'id_number', 'badge_number']
    ordering      = ['full_name']

    fieldsets = (
        (None, {'fields': ('email', 'password')}),
        ('Personal Info', {'fields': (
            'full_name', 'last_name', 'first_name', 'middle_name',
            'id_number', 'phone_number',
        )}),
        ('Role', {'fields': ('role', 'hired_year', 'badge_number', 'assigned_area')}),
        ('Permissions', {'fields': ('is_active', 'is_staff', 'is_superuser')}),
        ('Dates', {'fields': ('date_joined', 'last_login')}),
    )

    add_fieldsets = (
        (None, {
            'classes': ('wide',),
            'fields': (
                'email', 'full_name', 'last_name', 'first_name', 'middle_name',
                'id_number', 'role', 'password1', 'password2',
            ),
        }),
    )


@admin.register(UserRoleHistory)
class UserRoleHistoryAdmin(admin.ModelAdmin):
    """Read-only view of the transition ledger. Rows are only ever written by
    the controlled role-change service (later phase) — never by hand."""
    list_display  = ['effective_at', 'user', 'old_role', 'old_id_number', 'new_role', 'new_id_number', 'changed_by']
    list_filter   = ['old_role', 'new_role']
    search_fields = ['old_id_number', 'new_id_number', 'user__full_name', 'user__email']
    ordering      = ['-effective_at']

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False