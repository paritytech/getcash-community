<script setup lang="ts">
// The token to send for a trapped top-up's claim fee: the ones a top-up takes on Polkadot, as
// the worker priced them. Skeleton rows stand in until it has. A pick opens the deposit screen
// on the token.
import { computed } from "vue";
import type { RecoveryToken } from "@getsome/funding";
import type { RecoveryChoice } from "../../funding/recovery-deposit";
import { networkIcon, tokenIcon } from "../../utils/icons";
import type { OptionListRow } from "../../utils/option-list";
import NetworkRecapBar from "../ui/NetworkRecapBar.vue";
import OptionList from "../ui/OptionList.vue";
import PillButton from "../ui/PillButton.vue";
import ScreenFrame from "../ui/ScreenFrame.vue";

interface TokenOption extends OptionListRow {
  token: RecoveryToken;
}

const props = defineProps<{
  choices: readonly RecoveryChoice[];
  /** The worker has priced the tokens: no choice then means none can be sent today. */
  priced: boolean;
}>();
const emit = defineEmits<{ pick: [token: RecoveryToken]; back: [] }>();

/** One skeleton per token the worker prices. */
const PLACEHOLDERS: TokenOption[] = (["PAS", "DOTUSD", "USDC", "USDT"] as const).map((token) => ({
  key: token,
  icon: "",
  label: "",
  pickable: false,
  token,
}));

const loading = computed(() => !props.priced);
const rows = computed<TokenOption[]>(() =>
  loading.value
    ? PLACEHOLDERS
    : props.choices.map((choice) => ({
        key: choice.token,
        icon: tokenIcon(choice.name),
        label: choice.name,
        pickable: true,
        token: choice.token,
      })),
);
</script>

<template>
  <ScreenFrame>
    <!-- The cards bleed past the 24px content gutter to the design's 16px inset. -->
    <NetworkRecapBar
      class="-mx-2"
      caption="Network"
      label="Polkadot"
      :icon="networkIcon('Polkadot')"
    />
    <div class="mt-4 flex min-h-0 flex-1 flex-col">
      <p v-if="priced && !choices.length" class="text-center text-body-m text-fg-secondary">
        No token can be priced right now. Try again in a moment.
      </p>
      <OptionList
        v-else
        :rows="rows"
        :loading="loading"
        label="Tokens"
        @pick="emit('pick', $event.token)"
      />
    </div>

    <template #actions>
      <PillButton variant="secondary" @click="emit('back')">Back</PillButton>
    </template>
  </ScreenFrame>
</template>
