"""
Single definition of "which notifications may this account see / mark read".

  * role broadcast rows (recipient_user IS NULL): visible to everyone currently
    holding recipient_role - unchanged legacy behaviour, shared read state.
  * personal rows (recipient_user set): visible ONLY to that account, whatever
    role it holds now (so a converted account keeps its own earlier personal
    notifications), and never to anyone else.

Every read path (REST list, unread count, mark-read, mark-all, SSE start id and
SSE poll) must go through here so a personal notification can never leak to
another user of the same role or share read state with them.
"""
from django.db.models import Q


def visible_to(user_id, role):
    broadcast = Q(recipient_role=role, recipient_user__isnull=True)
    if user_id is None:
        # Never emit recipient_user_id=None: Django turns that into IS NULL,
        # which would match every broadcast row of every role.
        return broadcast
    return broadcast | Q(recipient_user_id=user_id)