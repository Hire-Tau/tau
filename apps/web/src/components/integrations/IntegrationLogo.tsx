import type { ComponentType } from 'react'
import bigbrainLogo from '../../assets/bigbrain-mark.png'
import {
  AppleIcon,
  BellIcon,
  CloudflareIcon,
  DigitalOceanIcon,
  DiscordIcon,
  GitHubIcon,
  GoogleCloudIcon,
  LinearIcon,
  NetlifyIcon,
  NotionIcon,
  OpenAIIcon,
  RailwayIcon,
  SlackIcon,
  SupabaseIcon,
  TelegramIcon,
  VercelIcon,
} from '../icons'
import type { IconProps } from '../icons/types'

const logos: Record<string, ComponentType<IconProps>> = {
  'apple-push': AppleIcon,
  'web-push': BellIcon,
  cloudflare: CloudflareIcon,
  digitalocean: DigitalOceanIcon,
  discord: DiscordIcon,
  github: GitHubIcon,
  'google-cloud': GoogleCloudIcon,
  linear: LinearIcon,
  netlify: NetlifyIcon,
  notion: NotionIcon,
  'openai-services': OpenAIIcon,
  railway: RailwayIcon,
  slack: SlackIcon,
  supabase: SupabaseIcon,
  telegram: TelegramIcon,
  vercel: VercelIcon,
}

/** Shared by global and squad cards; custom integrations retain a letter fallback. */
export function IntegrationLogo({ provider, label }: { provider: string; label: string }) {
  if (provider === 'bigbrain') return <img src={bigbrainLogo} alt="" className="h-8 w-8 rounded-md" />
  const Logo = Object.hasOwn(logos, provider) ? logos[provider] : undefined
  return Logo ? <Logo className="h-7 w-7" /> : <>{label.slice(0, 1)}</>
}
