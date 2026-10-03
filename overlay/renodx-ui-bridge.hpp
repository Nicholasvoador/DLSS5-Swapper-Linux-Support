// Experimental, hash-pinned UI adapter, NOT a public RenoDX API.
// During a synchronous call to the original panel only, replace its private
// ImGui table pointer with a local copy. Restore it before returning. Slider
// pointers are callback-local; never retain them or write NR globals by offset.
#pragma once
#include "renodx-ui-probe.hpp"
#include <mutex>
namespace nr_live {
// The INI section RenoDX keeps its settings in. Read, never written: a switch
// or a style row carries no value the bridge can see, so its current value is
// what RenoDX itself last stored through ReShade.
inline constexpr const char *config_section = "RenoDX.DLSS5";
struct field {
    const char *label; uint32_t kind;
    // How 8.x names the same setting: the PushID its "##value" widget sits
    // under, which is also its INI key. Null where 8.x has no such control.
    const char *key = nullptr;
    float value = 0, min = 0, max = 1, requested = 0;
    bool seen = false, pending = false, confirming = false;
    std::vector<std::string> options;
    std::vector<std::string> pass_options;   // collected during one hidden pass
    int pass_selected = -1;
    int click_index = -1;                    // the choice to press during this pass
};
struct controls;
inline thread_local controls *current = nullptr;
inline std::mutex invocation;
struct controls {
    bool enabled = true, active = false;
    std::string reason = "Bridge is off";
    HMODULE checked = nullptr;
    // Which pinned build is loaded. Null means one this adapter cannot drive.
    const nr_probe::build_pin *build = nullptr;
    const imgui_function_table *original = nullptr;
    unsigned disabled = 0;
    std::vector<bool> disabled_stack;
    // Matched by label, so a build that renames or drops one loses that control
    // and keeps the rest: 6.x dropped "Enable Upscaling (WIP)" and nothing else.
    // 8.x is matched by key instead, and has dropped "Global Tone Intensity" too.
    std::array<field, 15> fields = {{
        {"Structure Intensity", 0, "NRLocalStructure"}, {"Global Tone Intensity", 0},
        {"Enable DLSS Neural Rendering", 1, "NeuralUplift"}, {"Automatic / Character Mask", 1, "NRAutoMask"},
        {"Character/Skin Structure", 0, "NRSkinStructure"}, {"Overall Intensity", 0, "NRIntensity"},
        {"Local Tone Intensity", 0, "NRLocalTone"}, {"Diffuse White (nits)", 0, "NRDiffuseWhiteNits"},
        {"Motion Scale X Multiplier", 0, "NRMVecScaleX"}, {"Motion Scale Y Multiplier", 0, "NRMVecScaleY"},
        {"NR UI Correction", 1, "NRUICorrection"}, {"Enable Upscaling (WIP)", 1},
        {"NR Preset", 4, "NRPreset"}, {"NR Style", 4, "NRStyle"}, {"Depth Convention", 4, "NRDepthMode"}
    }};
    // The ImGui ID stack as the original callback builds it. 8.x says which
    // setting a widget belongs to only through it.
    std::vector<std::string> ids;
    // Combos this pass opened on paper only. ImGui never saw them open, so
    // their EndCombo must not reach ImGui either.
    unsigned fake_combos = 0;
    field *combo_field = nullptr;
    int combo_index = 0;
    field *by_key(const char *key, uint32_t kind) {
        if (!key) return nullptr;
        for (auto &f : fields) if (f.key && f.kind == kind && strcmp(f.key, key) == 0) return &f;
        return nullptr;
    }
    // The innermost ID naming a field of this kind.
    field *keyed(uint32_t kind) {
        for (auto it = ids.rbegin(); it != ids.rend(); ++it) if (auto f = by_key(it->c_str(), kind)) return f;
        return nullptr;
    }
    static bool config_int(const char *key, int &value) {
        return reshade::get_config_value(nullptr, config_section, key, value);
    }
    void clear() { active = false; for (auto &f : fields) { f.seen = f.pending = f.confirming = false; } }
    bool accept(uint32_t epoch, lab_live::command c) {
        if (c.epoch != epoch || !std::isfinite(c.value)) return false;
        if (c.id == 200) {
            if (c.kind != 1 || (c.value != 0 && c.value != 1)) return false;
            enabled = c.value != 0; clear(); return true;
        }
        if (!enabled || !active || c.id < 101 || c.id >= 101 + fields.size()) return false;
        auto &f = fields[c.id - 101];
        if (f.kind == 4 && std::floor(c.value) != c.value) return false;
        if (!f.seen || f.kind != c.kind || c.value < f.min || c.value > f.max || (f.kind == 1 && c.value != 0 && c.value != 1)) return false;
        f.requested = c.value; f.pending = true; return true;
    }
    bool visit(const char *label, uint32_t kind, float &value, float lo, float hi) {
        // 6.x labels its widgets; 8.x draws "##value" under the setting's ID.
        if (label && label[0] == '#' && label[1] == '#') {
            field *f = keyed(kind);
            return f ? visit_field(*f, value, lo, hi) : false;
        }
        for (auto &f : fields) if (f.kind == kind && strcmp(f.label, label) == 0) return visit_field(f, value, lo, hi);
        return false;
    }
    bool visit_field(field &f, float &value, float lo, float hi) {
        if (disabled || !std::isfinite(value) || !std::isfinite(lo) || !std::isfinite(hi) || lo >= hi) return false;
        f.seen = true; f.min = lo; f.max = hi; f.value = value;
        if (f.confirming) {
            if (std::abs(value - f.requested) < .0001f) {
                char message[220]; snprintf(message, sizeof(message), "NR_LAB_READBACK %s=%.4f (original RenoDX callback)", f.label, value);
                reshade::log::message(reshade::log::level::info, message);
            }
            f.confirming = false;
        }
        if (f.pending) {
            f.pending = false;
            if (f.requested < lo || f.requested > hi) return false;
            value = f.requested; f.confirming = true; return true;
        }
        return false;
    }
    static bool slider(const char *label, float *v, float lo, float hi, const char *format, ImGuiSliderFlags flags) {
        auto &s = *current;
        return s.visit(label, 0, *v, lo, hi); // Hidden evaluation must never react to user mouse input.
    }
    static bool checkbox(const char *label, bool *v) {
        float value = *v ? 1.f : 0.f;
        if (!current->visit(label, 1, value, 0, 1)) return false;
        *v = value != 0; return true;
    }
    // 8.x choices, read and pressed the way a person would: a switch is one
    // InvisibleButton that flips the setting when clicked; a style row is one
    // Button per option under the setting's "##value" ID. Neither hands over a
    // value, so the current one is what RenoDX stored, and a change is exactly
    // one click on the original control - never a write to the setting itself.
    static int choice_limit(const field &f) { return f.options.empty() ? 15 : static_cast<int>(f.options.size()) - 1; }
    static std::string shown(const char *label) {
        std::string text(label, strnlen(label, 128));
        const size_t hidden = text.find("##");
        return hidden == std::string::npos ? text : text.substr(0, hidden);
    }
    static bool button(const char *label, const ImVec2 &) {
        auto &s = *current;
        if (!label || s.ids.empty() || s.ids.back() != "##value") return false;
        field *f = s.keyed(4);
        if (!f) return false;
        const int index = static_cast<int>(f->pass_options.size());
        if (index >= 16) return false;
        if (index == 0) {
            // First button of the row: decide, once, whether this pass presses one.
            int stored = 0;
            if (!config_int(f->key, stored) || stored < 0 || stored > 15) return false;
            float value = static_cast<float>(stored);
            if (s.visit_field(*f, value, 0, static_cast<float>(choice_limit(*f))) && static_cast<int>(value) != stored)
                f->click_index = static_cast<int>(value);
            f->pass_selected = stored;
        }
        f->pass_options.emplace_back(shown(label));
        return index == f->click_index;
    }
    static bool small_button(const char *) { return false; }
    static bool invisible(const char *label, const ImVec2 &, ImGuiButtonFlags) {
        auto &s = *current;
        if (!label) return false;
        field *f = strcmp(label, "##nr_enable") == 0 ? s.by_key("NeuralUplift", 1)
                 : strcmp(label, "##value") == 0 ? s.keyed(1) : nullptr;
        int stored = 0;
        if (!f || !config_int(f->key, stored) || (stored != 0 && stored != 1)) return false;
        float value = static_cast<float>(stored);
        if (!s.visit_field(*f, value, 0, 1)) return false;
        return (value != 0) != (stored != 0);
    }
    // An 8.x drop-down is opened on paper only: ImGui never sees it open, its
    // EndCombo never reaches ImGui, and its items say which one is selected.
    static bool begin_combo(const char *label, const char *preview, ImGuiComboFlags flags) {
        auto &s = *current;
        field *f = label && strcmp(label, "##value") == 0 && !s.combo_field ? s.keyed(4) : nullptr;
        if (!f) return s.original->BeginCombo(label, preview, flags);
        int stored = 0;
        if (!config_int(f->key, stored) || stored < 0 || stored > 15) return false;
        float value = static_cast<float>(stored);
        if (s.visit_field(*f, value, 0, static_cast<float>(choice_limit(*f))) && static_cast<int>(value) != stored)
            f->click_index = static_cast<int>(value);
        f->pass_options.clear(); f->pass_selected = -1;
        s.combo_field = f; s.combo_index = 0; ++s.fake_combos;
        return true;
    }
    static void end_combo() {
        auto &s = *current;
        if (s.fake_combos) { --s.fake_combos; s.combo_field = nullptr; return; }
        s.original->EndCombo();
    }
    static bool selectable(const char *label, bool selected, ImGuiSelectableFlags flags, const ImVec2 &size) {
        auto &s = *current;
        if (!s.combo_field) return s.original->Selectable(label, selected, flags, size);
        field &f = *s.combo_field; const int index = s.combo_index++;
        if (index >= 16 || !label) return false;
        f.pass_options.emplace_back(shown(label));
        if (selected) f.pass_selected = index;
        return index == f.click_index;
    }
    static bool selectable2(const char *label, bool *selected, ImGuiSelectableFlags flags, const ImVec2 &size) {
        auto &s = *current;
        if (!s.combo_field) return s.original->Selectable2(label, selected, flags, size);
        bool picked = selectable(label, selected && *selected, flags, size);
        if (picked && selected) *selected = true;
        return picked;
    }
    static void push_id(const char *id) { current->ids.emplace_back(id ? id : ""); current->original->PushID(id); }
    static void push_id2(const char *begin, const char *end) {
        current->ids.emplace_back(begin && end && end >= begin ? std::string(begin, end) : std::string(begin ? begin : ""));
        current->original->PushID2(begin, end);
    }
    static void push_id3(const void *id) { current->ids.emplace_back(); current->original->PushID3(id); }
    static void push_id4(int id) { current->ids.emplace_back(); current->original->PushID4(id); }
    static void pop_id() { if (!current->ids.empty()) current->ids.pop_back(); current->original->PopID(); }
    static bool combo(const char *label, int *v, const char *const items[], int count, int) {
        if (count < 2 || count > 16 || *v < 0 || *v >= count) return false;
        for (auto &f : current->fields) if (f.kind == 4 && strcmp(f.label, label) == 0) {
            std::vector<std::string> names;
            for (int i = 0; i < count; ++i) {
                if (!items[i] || strnlen(items[i], 129) > 128) return false;
                names.emplace_back(items[i]);
            }
            f.options = std::move(names);
            float value = static_cast<float>(*v);
            if (!current->visit(label, 4, value, 0, static_cast<float>(count - 1))) return false;
            *v = static_cast<int>(value); return true;
        }
        return false;
    }
    static bool combo2(const char *label, int *v, const char *items, int height) {
        const char *names[16]; int count = 0; size_t used = 0;
        while (items && *items && count < 16 && used < 2064) {
            size_t n = strnlen(items, 129); if (n > 128) return false;
            names[count++] = items; items += n + 1; used += n + 1;
        }
        if (!items || *items) return false;
        return combo(label, v, names, count, height);
    }
    static void begin_disabled(bool v) {
        current->disabled_stack.push_back(v); if (v) ++current->disabled;
        current->original->BeginDisabled(v);
    }
    static void end_disabled() {
        if (!current->disabled_stack.empty()) { if (current->disabled_stack.back()) --current->disabled; current->disabled_stack.pop_back(); }
        current->original->EndDisabled();
    }
    // A build that files its controls under collapsing sections draws nothing
    // inside a closed one, and this pass runs in a hidden window with no saved
    // settings, so every section starts closed. Asking for them open keeps
    // ImGui's own push/pop pairing intact - returning true for a header the
    // original refused would leave a TreePop without its TreeNode.
    static bool collapsing(const char *label, ImGuiTreeNodeFlags flags) {
        return current->original->CollapsingHeader(label, flags | ImGuiTreeNodeFlags_DefaultOpen);
    }
    static bool collapsing2(const char *label, bool *visible, ImGuiTreeNodeFlags flags) {
        return current->original->CollapsingHeader2(label, visible, flags | ImGuiTreeNodeFlags_DefaultOpen);
    }
    static bool tree_node(const char *label, ImGuiTreeNodeFlags flags) {
        return current->original->TreeNodeEx(label, flags | ImGuiTreeNodeFlags_DefaultOpen);
    }
    // Which controls the hidden pass actually reached. A panel with nothing in
    // it is otherwise silent about why, and the answer is always one of: the
    // file is a build this adapter does not know, its code does not look the
    // way that build's does, or the page drew fewer controls than expected.
    std::string missing() const {
        std::string out; unsigned found = 0;
        for (const auto &f : fields) if (f.seen) ++found;
        out = std::to_string(found) + "/" + std::to_string(fields.size());
        for (const auto &f : fields) if (!f.seen) { out += out.size() ? ", " : ""; out += f.label; }
        return out;
    }
    std::string announced;
    void announce() {
        char line[900];
        snprintf(line, sizeof(line), "NR_LAB_BRIDGE build=%s active=%d controls=%s reason=\"%s\"",
                 build ? build->name : "none", active ? 1 : 0, missing().c_str(), reason.c_str());
        if (announced == line) return;
        announced = line;
        reshade::log::message(reshade::log::level::info, line);
    }
    void tick(reshade::api::effect_runtime *runtime) { decide(runtime); announce(); }
    void decide(reshade::api::effect_runtime *runtime) {
        if (!enabled) { clear(); reason = "Bridge is off"; return; }
        HMODULE module = GetModuleHandleW(L"renodx-dlss5.addon64");
        if (!module) { clear(); reason = "RenoDX is not loaded"; return; }
        if (module != checked) { checked = module; build = nr_probe::identify(module); }
        if (!build) { clear(); reason = "Unsupported RenoDX binary; this build drives RenoDX 8.5.0-rc10, 6.5.3 and v4.7"; return; }
        auto base = reinterpret_cast<unsigned char *>(module);
        auto slot = reinterpret_cast<const imgui_function_table **>(base + build->slot);
        original = imgui_function_table_instance();
        if (*slot != original) { clear(); reason = "Unexpected ImGui interface; bridge refused"; return; }
        // Validate the in-memory initialization and registration sites as well
        // as the on-disk hash. Never guess offsets for another build: each one
        // brings its own, and an unrecognised file never reaches this point.
        if (memcmp(base + build->init_at, build->init, build->init_size) ||
            memcmp(base + build->call_at, build->call, build->call_size)) {
            clear(); reason = "RenoDX code fingerprint mismatch"; return;
        }
        std::unique_lock<std::mutex> lock(invocation, std::try_to_lock);
        if (!lock.owns_lock() || current) return;
        imgui_function_table table = *original;
        table.SliderFloat = slider; table.Checkbox = checkbox;
        table.Button = button; table.SmallButton = small_button; table.InvisibleButton = invisible;
        table.Combo = combo; table.Combo2 = combo2;
        table.BeginCombo = begin_combo; table.EndCombo = end_combo;
        table.Selectable = selectable; table.Selectable2 = selectable2;
        table.PushID = push_id; table.PushID2 = push_id2; table.PushID3 = push_id3; table.PushID4 = push_id4; table.PopID = pop_id;
        table.BeginDisabled = begin_disabled; table.EndDisabled = end_disabled;
        table.CollapsingHeader = collapsing; table.CollapsingHeader2 = collapsing2; table.TreeNodeEx = tree_node;
        disabled = 0; disabled_stack.clear();
        ids.clear(); fake_combos = 0; combo_field = nullptr; combo_index = 0;
        for (auto &f : fields) { f.seen = false; f.pass_options.clear(); f.pass_selected = -1; f.click_index = -1; }
        // On screen, drawn at an alpha that rounds to nothing, taking no input.
        // The pass used to sit at -30000: ImGui hides a child window it can clip
        // away entirely, and 8.x draws its whole page inside one, so that pass
        // saw no control at all. The alpha must stay above zero - ImGui skips
        // the items of a window begun at alpha 0.
        const ImVec2 display = ImGui::GetIO().DisplaySize;
        ImGui::SetNextWindowPos(ImVec2(0, 0));
        ImGui::SetNextWindowSize(ImVec2(display.x > 1 && display.x < 600 ? display.x : 600, display.y > 1 ? display.y : 1000));
        ImGui::PushStyleVar(ImGuiStyleVar_Alpha, .001f);
        ImGui::Begin("##NRLabAdapter", nullptr, ImGuiWindowFlags_NoInputs | ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoBackground |
                     ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoBringToFrontOnFocus | ImGuiWindowFlags_NoNav);
        auto atomic_slot = reinterpret_cast<void *volatile *>(base + build->slot);
        if (InterlockedCompareExchangePointer(atomic_slot, &table, const_cast<imgui_function_table *>(original)) != original) {
            ImGui::End(); ImGui::PopStyleVar(); clear(); reason = "UI dispatch changed; bridge refused"; return;
        }
        {
            struct guard {
                void *volatile *slot; const imgui_function_table *old; imgui_function_table *temporary;
                ~guard() { InterlockedCompareExchangePointer(slot, const_cast<imgui_function_table *>(old), temporary); current = nullptr; }
            } restore {atomic_slot, original, &table};
            current = this;
            reinterpret_cast<void (*)(reshade::api::effect_runtime *)>(base + build->overlay)(runtime);
        }
        ImGui::End(); ImGui::PopStyleVar();
        combo_field = nullptr; fake_combos = 0;
        // A choice read during the pass becomes its options and its value.
        for (auto &f : fields) if (f.seen && !f.pass_options.empty()) {
            f.options = f.pass_options;
            f.min = 0; f.max = static_cast<float>(f.options.size() - 1);
            if (f.pass_selected >= 0 && f.pass_selected <= static_cast<int>(f.max)) f.value = static_cast<float>(f.pass_selected);
        }
        // Commands for a hidden/disabled control expire, never apply later.
        for (auto &f : fields) if (!f.seen) f.pending = f.confirming = false;
        // Structure and the NR switch are what make the panel worth showing.
        // Global Tone used to be required too; 8.x no longer has it.
        active = fields[0].seen && fields[2].seen;
        reason = active ? "" : "RenoDX controls unavailable";
    }
    std::string json() const {
        std::ostringstream out; out.imbue(std::locale::classic());
        out << ",\"nrAvailable\":" << (active ? "true" : "false") << ",\"nrReason\":" << lab_live::quoted(reason)
            << ",\"nrEnabled\":" << (enabled ? "true" : "false") << ",\"nrTools\":[";
        for (size_t i = 0; i < fields.size(); ++i) {
            const auto &f = fields[i]; if (i) out << ',';
            out << "{\"id\":" << 101+i << ",\"kind\":" << f.kind << ",\"name\":" << lab_live::quoted(f.label)
                << ",\"effect\":\"RenoDX " << (build ? build->name : "") << "\",\"min\":" << f.min << ",\"max\":" << f.max
                << ",\"step\":" << (f.kind == 0 ? "0.01" : "1") << ",\"value\":" << f.value << ",\"available\":" << (active && f.seen ? "true" : "false");
            if (f.kind == 4) {
                out << ",\"options\":[";
                for (size_t j = 0; j < f.options.size(); ++j) { if (j) out << ','; out << lab_live::quoted(f.options[j]); }
                out << ']';
            }
            out << '}';
        }
        return out.str() + "]";
    }
};
}
