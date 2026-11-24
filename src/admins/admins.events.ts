/**
 * #24 (L-02): the admin team changed. Open dashboards get `admins:updated` on the
 * admin socket and reload the team list — an invitation is accepted in the
 * invitee's own browser, so the inviter's list could not know otherwise.
 */
export const ADMIN_TEAM_EVENTS = {
  changed: 'admin_team.changed',
} as const;

export interface AdminTeamChangedEvent {
  reason: 'invitation_sent' | 'invitation_accepted' | 'invitation_revoked' | 'admin_removed';
  userId: string | null;
  invitationId: string | null;
}
