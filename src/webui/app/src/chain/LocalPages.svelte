<script lang="ts">
  // The pages of Thunder (chain/local.ts lists them): the one shown.
  import BatchPay from './pages/BatchPay.svelte';
  import Payments from './pages/Payments.svelte';
  import Throughput from './pages/Throughput.svelte';
  let { page }: { page: string } = $props();
</script>

{#if page === 'batchpay'}<BatchPay />
{:else if page === 'payments'}<Payments />
{:else if page === 'throughput'}<Throughput />
{/if}
