export const dynamic = 'force-dynamic';
import { AuthForm } from '@/components/AuthForm';
import { AuthShell } from '@/components/AuthShell';
import { authStats } from '@/lib/auth-stats';

export default async function Login() {
  return (
    <AuthShell stats={await authStats()} title="Welcome back" hint="Your workspace, your candidates, your leads.">
      <AuthForm mode="login" />
    </AuthShell>
  );
}
