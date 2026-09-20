import { AppException } from '../common/errors/app.exception.js';

/** status-rules §1: you can't remove yourself or the last admin (no active admin would remain). */
export function assertCanRemoveAdmin(input: { actorId: string; targetId: string; remainingActiveAdmins: number }): void {
  if (input.actorId === input.targetId) {
    throw AppException.of('CANNOT_REMOVE_SELF');
  }
  if (input.remainingActiveAdmins < 1) {
    throw AppException.of('LAST_ADMIN');
  }
}

/** Email changes on the own account need the current password. */
export function emailChangeNeedsPassword(currentEmail: string, nextEmail: string | undefined): boolean {
  return nextEmail !== undefined && nextEmail !== currentEmail;
}
