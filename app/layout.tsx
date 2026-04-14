import './globals.css'

export const metadata = {
  title: 'BeatSync PRO',
  description: 'Synchronise tes vidéos avec les beats de ta musique',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  )
}
