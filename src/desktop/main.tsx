  const setBusyBoth = useCallback((v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  }, []);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [discoveredPrinters, setDiscoveredPrinters] = useState<PrinterInfo[]>([]);
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printersError, setPrintersError] = useState<string | null>(null);
  const [printersFilter, setPrintersFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<PrinterStatusFilter>("all");
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [jobTab, setJobTab] = useState<JobTab>("all");
  const [jobSearch, setJobSearch] = useState("");
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [lastStatusCheck, setLastStatusCheck] = useState<string | null>(null);