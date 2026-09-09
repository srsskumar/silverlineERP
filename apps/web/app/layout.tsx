import type { Metadata } from 'next';
import { AuthProvider } from '@/components/AuthProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Silverline ERP',
  description: 'Silverline ERP — field operations, attendance, projects and tasks.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
