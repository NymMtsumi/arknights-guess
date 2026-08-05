'use client';

import { I18nProvider } from '@/lib/i18n';
import { AnnouncementPopup } from '@/components/AnnouncementPopup';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <AnnouncementPopup />
      {children}
    </I18nProvider>
  );
}
