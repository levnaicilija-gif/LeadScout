import './globals.css';
export const metadata = { title: 'LeadScout', description: 'Know who needs people before the job is posted.' };
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body className="font-sans text-[14px] leading-[1.45]">{children}</body>
    </html>
  );
}
