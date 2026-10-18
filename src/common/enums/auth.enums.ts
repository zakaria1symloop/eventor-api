export enum SessionAudience {
  Dashboard = 'dashboard',
  App = 'app',
}

export enum VerificationCodePurpose {
  EmailVerify = 'email_verify',
  PasswordReset = 'password_reset',
  EmailChange = 'email_change',
  FormSubmission = 'form_submission',
  /** The public account deletion page (no password, or a forgotten one). */
  AccountDeletion = 'account_deletion',
}
