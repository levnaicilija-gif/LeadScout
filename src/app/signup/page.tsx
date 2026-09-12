export const dynamic = 'force-dynamic';
import { AuthForm } from '@/components/AuthForm';
import { AuthShell } from '@/components/AuthShell';
import { authStats } from '@/lib/auth-stats';

export default async function Signup() {
  return (
    <AuthShell stats={await authStats()} title="Create your workspace" hint="14 days free. No card.">
      <AuthForm mode="signup" />
    </AuthShell>
  );
}
