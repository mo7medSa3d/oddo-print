package main

import (
	"testing"

	"github.com/yaseir-agent/agent/internal/printer"
)

func TestAppendVirtualQueueObservationsPreservesProductionAndSeparatesClassification(t *testing.T) {
	managed := []printer.DeviceInfo{{ID: "physical-1", Name: "Real printer", PrinterType: "physical"}}
	queues := []printer.DeviceInfo{
		{ID: "physical-1", Name: "Real printer", PrinterType: "physical"},
		{ID: "virtual-1", Name: "Microsoft Print to PDF", PrinterType: "virtual", Protocol: "spooler"},
		{ID: "virtual-1", Name: "Duplicate PDF", PrinterType: "virtual", Protocol: "spooler"},
		{ID: "redirect-1", Name: "Remote printer", PrinterType: "redirected", Protocol: "spooler"},
	}
	all := appendVirtualQueueObservations(managed, queues)
	if len(all) != 3 || all[0].ID != "physical-1" || all[1].ID != "virtual-1" || all[2].ID != "redirect-1" {
		t.Fatalf("unexpected diagnostic inventory: %+v", all)
	}
	if len(managed) != 1 || printer.IsProductionPrinter(all[1]) || printer.IsProductionPrinter(all[2]) {
		t.Fatal("inspecting virtual queues must not promote virtual/redirected queues to production")
	}
}
