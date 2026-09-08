<script lang="ts" setup>
// Diverges from the shadcn-vue registry in two ways, both allowlisted:
// the registry's @radix-icons/vue imports are swapped for lucide-vue-next
// (the design system allows exactly one icon set), and vue-sonner v2's
// required stylesheet is imported here so the component is self-contained.
import type { ToasterProps } from "vue-sonner"
import { CircleCheck, Info, LoaderCircle, CircleX, TriangleAlert, X } from "lucide-vue-next"
import { Toaster as Sonner } from "vue-sonner"
import { cn } from '@/lib/cn'
import "vue-sonner/style.css"

const props = defineProps<ToasterProps>()
</script>

<template>
  <Sonner
    :class="cn('toaster group', props.class)"
    :style="{
      '--normal-bg': 'var(--popover)',
      '--normal-text': 'var(--popover-foreground)',
      '--normal-border': 'var(--border)',
      '--border-radius': 'var(--radius)',
    }"
    v-bind="props"
  >
    <template #success-icon>
      <CircleCheck class="size-4" />
    </template>
    <template #info-icon>
      <Info class="size-4" />
    </template>
    <template #warning-icon>
      <TriangleAlert class="size-4" />
    </template>
    <template #error-icon>
      <CircleX class="size-4" />
    </template>
    <template #loading-icon>
      <div>
        <LoaderCircle class="size-4 animate-spin" />
      </div>
    </template>
    <template #close-icon>
      <X class="size-4" />
    </template>
  </Sonner>
</template>
