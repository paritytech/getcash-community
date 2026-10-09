<script setup lang="ts">
// The provider's terms as one line above the Continue that accepts them, each document a link
// that opens on its own. Draws nothing when the provider lists none.
import { computed } from "vue";
import type { ProviderAgreement } from "@getsome/meld";
import { agreementLinks } from "../../../composables/useMeldRequirements";

const props = defineProps<{
  /** The provider's name as the buyer reads it. */
  provider: string;
  agreements: readonly ProviderAgreement[];
}>();

const links = computed(() => agreementLinks(props.agreements));
</script>

<template>
  <p v-if="links.length > 0" class="text-center text-body-s text-fg-secondary">
    By continuing you accept {{ provider }}'s
    <template v-for="(link, i) in links" :key="i"
      ><a
        :href="link.url"
        target="_blank"
        rel="noopener noreferrer"
        class="text-fg-primary underline"
        >{{ link.name }}</a
      >{{ link.after }}</template
    >.
  </p>
</template>
