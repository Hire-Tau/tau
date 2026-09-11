import type { StatusRole } from '@tau/shared'
import type { BadgeColor } from '../components/Badge'

export interface WebStatusTreatment {
  markerClass: string
  markerHex: string
  textClass: string
  surfaceClass: string
  borderClass: string
  badgeColor: BadgeColor
}

export const WEB_STATUS = {
  progress: {
    markerClass: 'bg-blue-500',
    markerHex: '#3b82f6',
    textClass: 'text-blue-700 dark:text-blue-400',
    surfaceClass: 'bg-blue-50 dark:bg-blue-900/20',
    borderClass: 'border-blue-200 dark:border-blue-800',
    badgeColor: 'blue',
  },
  queue: {
    markerClass: 'bg-cyan-500',
    markerHex: '#06b6d4',
    textClass: 'text-cyan-700 dark:text-cyan-400',
    surfaceClass: 'bg-cyan-50 dark:bg-cyan-900/20',
    borderClass: 'border-cyan-200 dark:border-cyan-800',
    badgeColor: 'cyan',
  },
  review: {
    markerClass: 'bg-yellow-500',
    markerHex: '#eab308',
    textClass: 'text-yellow-700 dark:text-yellow-400',
    surfaceClass: 'bg-yellow-50 dark:bg-yellow-900/20',
    borderClass: 'border-yellow-200 dark:border-yellow-800',
    badgeColor: 'yellow',
  },
  humanWait: {
    markerClass: 'bg-purple-500',
    markerHex: '#a855f7',
    textClass: 'text-purple-700 dark:text-purple-400',
    surfaceClass: 'bg-purple-50 dark:bg-purple-900/20',
    borderClass: 'border-purple-200 dark:border-purple-800',
    badgeColor: 'purple',
  },
  externalWait: {
    markerClass: 'bg-orange-500',
    markerHex: '#f97316',
    textClass: 'text-orange-700 dark:text-orange-400',
    surfaceClass: 'bg-orange-50 dark:bg-orange-900/20',
    borderClass: 'border-orange-200 dark:border-orange-800',
    badgeColor: 'orange',
  },
  attention: {
    markerClass: 'bg-amber-500',
    markerHex: '#f59e0b',
    textClass: 'text-amber-700 dark:text-amber-400',
    surfaceClass: 'bg-amber-50 dark:bg-amber-900/20',
    borderClass: 'border-amber-200 dark:border-amber-800',
    badgeColor: 'amber',
  },
  danger: {
    markerClass: 'bg-red-500',
    markerHex: '#ef4444',
    textClass: 'text-red-700 dark:text-red-400',
    surfaceClass: 'bg-red-50 dark:bg-red-900/20',
    borderClass: 'border-red-200 dark:border-red-800',
    badgeColor: 'red',
  },
  success: {
    markerClass: 'bg-green-500',
    markerHex: '#22c55e',
    textClass: 'text-green-700 dark:text-green-400',
    surfaceClass: 'bg-green-50 dark:bg-green-900/20',
    borderClass: 'border-green-200 dark:border-green-800',
    badgeColor: 'green',
  },
  neutral: {
    markerClass: 'bg-gray-500',
    markerHex: '#6b7280',
    textClass: 'text-gray-700 dark:text-gray-400',
    surfaceClass: 'bg-gray-50 dark:bg-gray-900/20',
    borderClass: 'border-gray-200 dark:border-gray-800',
    badgeColor: 'gray',
  },
} as const satisfies Record<StatusRole, WebStatusTreatment>

export function webStatus(role: StatusRole): WebStatusTreatment {
  return WEB_STATUS[role]
}
