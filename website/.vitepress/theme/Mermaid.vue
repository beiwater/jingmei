<script setup lang="ts">
// Renders ```mermaid fences (see markdown.config in config.ts) in the browser, following the color mode.
import { useData } from "vitepress";
import { onMounted, ref, watch } from "vue";

const props = defineProps<{ code: string }>();
const { isDark } = useData();
const svg = ref("");
let renders = 0;

async function draw() {
	const { default: mermaid } = await import("mermaid");
	mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark.value ? "dark" : "neutral" });
	const id = `mermaid-${Math.random().toString(36).slice(2)}-${renders++}`;
	svg.value = (await mermaid.render(id, decodeURIComponent(props.code))).svg;
}

onMounted(draw);
watch(isDark, draw);
</script>

<template>
	<div class="mermaid-diagram" v-html="svg" />
</template>
