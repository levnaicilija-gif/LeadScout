import { redirect } from 'next/navigation';
/** Marketing page is a static file (public/landing.html) so design changes don't need a rebuild. */
export default function Home() { redirect('/landing.html'); }
