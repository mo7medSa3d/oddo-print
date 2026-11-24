package printer

import (
	"strings"

	"github.com/yaseir-agent/agent/internal/config"
)

// LocalPrinterDisablement is an immutable view of explicit operator denials.
// Desired state is never an input. Indexing once lets inventory/desired-state
// batches enforce the same decision without re-reading a registry per row.
type LocalPrinterDisablement struct {
	ids      map[string]struct{}
	localIDs map[string]struct{}
	bindings map[string]struct{}
}

func NewLocalPrinterDisablement(cfg *config.Config, registered []DeviceInfo) LocalPrinterDisablement {
	d := LocalPrinterDisablement{ids: make(map[string]struct{}), localIDs: make(map[string]struct{}), bindings: make(map[string]struct{})}
	deny := func(pc config.PrinterConfig) {
		if pc.ID != "" {
			d.ids[pc.ID] = struct{}{}
		}
		if digest, err := config.PrinterBindingDigest(pc); err == nil {
			d.bindings[digest] = struct{}{}
		}
	}
	if cfg != nil {
		for _, pc := range cfg.Printers {
			d.localIDs[pc.ID] = struct{}{}
			if !pc.IsEnabled() {
				deny(pc)
			}
		}
	}
	for _, device := range registered {
		d.localIDs[device.ID] = struct{}{}
		if device.Enabled {
			continue
		}
		deny(SharingConfigForDevice(device))
		// Use only the existing native queue/share proof, never a shared
		// friendly name, port, driver or serial, to identify another binding.
		if bindings, err := SharingBindingsForDevice(device, cfg); err == nil {
			for _, pc := range bindings {
				deny(pc)
			}
		}
	}
	return d
}

func LoadLocalPrinterDisablement(cfg *config.Config, registryPath string) (LocalPrinterDisablement, error) {
	registered, err := LoadRegistryPrinters(registryPath)
	if err != nil {
		return LocalPrinterDisablement{}, err
	}
	return NewLocalPrinterDisablement(cfg, registered), nil
}

func (d LocalPrinterDisablement) Disabled(pc config.PrinterConfig) bool {
	if !pc.IsEnabled() {
		return true
	}
	if _, disabled := d.ids[pc.ID]; disabled {
		return true
	}
	// The Gateway may address a local ID with its deterministic agent suffix.
	// An actual locally configured exact ID retains precedence; remote desired
	// state alone cannot create that local override or move a disabled alias.
	if _, exactLocal := d.localIDs[pc.ID]; !exactLocal {
		if i := strings.LastIndexByte(pc.ID, '~'); i > 0 && len(pc.ID)-i-1 == 8 {
			suffix := pc.ID[i+1:]
			if strings.Trim(suffix, "0123456789abcdef") == "" {
				if _, disabled := d.ids[pc.ID[:i]]; disabled {
					return true
				}
			}
		}
	}
	digest, err := config.PrinterBindingDigest(pc)
	if err != nil {
		return false // backend/admission validation owns unresolved destinations
	}
	_, disabled := d.bindings[digest]
	return disabled
}
