import express from "express";
import Lead from "../models/Lead.js";
import Activity from "../models/Activity.js";
import Followup from "../models/Followup.js";
import User from "../models/User.js";
import computeLeadScore from "../utils/leadScoring.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

async function smartAssignOwner() {
  const salesUsers = await User.find({ role: "sales", isActive: true });
  if (!salesUsers.length) return undefined;
  const counts = await Promise.all(
    salesUsers.map(async (u) => ({
      user: u._id,
      active: await Lead.countDocuments({
        owner: u._id,
        stage: { $nin: ["Won", "Lost"] },
      }),
    }))
  );
  const minCount = Math.min(...counts.map((c) => c.active));
  const candidates = counts.filter((c) => c.active === minCount);
  if (candidates.length === 1) return candidates[0].user;
  const speeds = await Promise.all(
    candidates.map(async (c) => {
      const closed = await Lead.find(
        { owner: c.user, stage: { $in: ["Won", "Lost"] } },
        "createdAt updatedAt"
      );
      const avg =
        closed.length > 0
          ? closed.reduce(
            (s, l) =>
              s + (new Date(l.updatedAt) - new Date(l.createdAt)),
            0
          ) / closed.length
          : Infinity;
      return { user: c.user, avg };
    })
  );
  speeds.sort((a, b) => a.avg - b.avg);
  return speeds[0].user;
}

function checkLeadAccess(req, lead) {
  if (req.user.role === "admin") return true;
  if (!lead.owner) return false;
  return lead.owner.toString() === req.user.id.toString();
}

router.post("/public", async (req, res) => {
  try {
    const data = req.body;
    const chargerInterest = Array.isArray(data.chargerInterest)
      ? data.chargerInterest
      : data.chargerInterest
        ? [data.chargerInterest]
        : [];

    let duplicateOf = null;
    if (data.phone || data.email) {
      const existing = await Lead.findOne({
        $or: [
          data.phone ? { phone: data.phone } : null,
          data.email ? { email: data.email } : null,
        ].filter(Boolean),
      });
      if (existing) {
        duplicateOf = existing._id;
      }
    }

    const assignedOwner = await smartAssignOwner();

    const lead = new Lead({
      leadType: data.leadType,
      name: data.name,
      phone: data.phone,
      email: data.email,
      area: data.area,
      locality: data.locality,
      propertySizeFlats: data.propertySizeFlats,
      parkingType: data.parkingType,
      currentEvCount: data.currentEvCount,
      chargerInterest,
      notes: data.notes,
      consent: !!data.consent,
      decisionMakerKnown: !!data.decisionMakerKnown,
      duplicateOf,
      owner: assignedOwner,
    });

    lead.leadScore = computeLeadScore(lead);
    await lead.save();
    lead.leadId = `ACS-${String(lead.createdAt.getTime()).slice(-6)}-${lead._id
      .toString()
      .slice(-4)}`;
    await lead.save();

    const ownerUser = assignedOwner
      ? await User.findById(assignedOwner, "name")
      : null;

    res.status(201).json({
      leadId: lead.leadId,
      id: lead._id,
      duplicate: !!duplicateOf,
      assignedTo: ownerUser ? ownerUser.name : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to create lead" });
  }
});

router.use(authMiddleware);

router.get("/", async (req, res) => {
  const {
    q,
    area,
    leadType,
    stage,
    owner,
    fromDate,
    toDate,
    limit = 500,
  } = req.query;

  const filter = {};
  if (req.user.role === "sales") {
    filter.owner = req.user.id;
  } else {
    if (owner) filter.owner = owner;
  }
  if (area) filter.area = new RegExp(area, "i");
  if (leadType) filter.leadType = leadType;
  if (stage) filter.stage = stage;
  if (fromDate || toDate) {
    filter.createdAt = {};
    if (fromDate) filter.createdAt.$gte = new Date(fromDate);
    if (toDate) filter.createdAt.$lte = new Date(toDate);
  }
  if (q) {
    filter.$or = [
      { name: new RegExp(q, "i") },
      { phone: new RegExp(q, "i") },
      { email: new RegExp(q, "i") },
      { area: new RegExp(q, "i") },
      { locality: new RegExp(q, "i") },
    ];
  }

  const leads = await Lead.find(filter)
    .populate("owner", "name email")
    .sort({ createdAt: -1 })
    .limit(Number(limit));

  res.json(leads);
});

router.get("/export/csv/all", async (req, res) => {
  const { owner, stage, fromDate, toDate } = req.query;
  const filter = {};
  if (req.user.role === "sales") {
    filter.owner = req.user.id;
  } else {
    if (owner) filter.owner = owner;
  }
  if (stage) filter.stage = stage;
  if (fromDate || toDate) {
    filter.createdAt = {};
    if (fromDate) filter.createdAt.$gte = new Date(fromDate);
    if (toDate) filter.createdAt.$lte = new Date(toDate);
  }
  const leads = await Lead.find(filter).populate("owner", "name");
  const fields = [
    "leadId",
    "leadType",
    "name",
    "phone",
    "email",
    "area",
    "locality",
    "propertySizeFlats",
    "parkingType",
    "currentEvCount",
    "chargerInterest",
    "stage",
    "leadScore",
    "ownerName",
    "createdAt",
  ];

  const escapeCsv = (value) => {
    if (value === null || value === undefined) return "";
    const str = String(value).replace(/\r?\n/g, " ");
    if (/[",]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = fields.join(",");
  const rows = leads.map((l) => {
    const obj = l.toObject();
    obj.chargerInterest = (obj.chargerInterest || []).join("|");
    obj.ownerName = l.owner?.name || "";
    return fields.map((f) => escapeCsv(obj[f])).join(",");
  });

  const csv = [header, ...rows].join("\n");
  res.header("Content-Type", "text/csv");
  res.attachment("acs-leads.csv");
  return res.send(csv);
});

router.get("/:id", async (req, res) => {
  const lead = await Lead.findById(req.params.id).populate(
    "owner",
    "name email"
  );
  if (!lead) return res.status(404).json({ message: "Lead not found" });
  if (!checkLeadAccess(req, lead))
    return res.status(403).json({ message: "Forbidden" });

  const activities = await Activity.find({ lead: lead._id })
    .populate("user", "name role")
    .sort({ createdAt: -1 });
  const followups = await Followup.find({ lead: lead._id }).sort({
    dueDate: 1,
  });

  res.json({ lead, activities, followups });
});

async function updateSalesAchieved(userId) {
  if (!userId) return;
  const wonCount = await Lead.countDocuments({ owner: userId, stage: "Won" });
  const user = await User.findById(userId);
  if (user) {
    user.salesAchieved = wonCount;
    user.incentiveEligible =
      user.salesTarget > 0 && wonCount >= user.salesTarget;
    await user.save();
  }
}

router.put("/:id", async (req, res) => {
  const updates = { ...req.body, updatedBy: req.user.id };
  const lead = await Lead.findById(req.params.id);
  if (!lead) return res.status(404).json({ message: "Lead not found" });
  if (!checkLeadAccess(req, lead))
    return res.status(403).json({ message: "Forbidden" });

  const oldStage = lead.stage;
  const oldOwner = lead.owner;
  Object.assign(lead, updates);
  lead.leadScore = computeLeadScore(lead);
  await lead.save();

  if (oldStage !== lead.stage) {
    await Activity.create({
      lead: lead._id,
      user: req.user.id,
      type: "note",
      subject: `Stage: ${oldStage} → ${lead.stage}`,
      description:
        req.body.stageNote ||
        `Lead moved from ${oldStage} to ${lead.stage}`,
      createdBy: req.user.id,
    });
  }

  if (
    oldStage !== lead.stage ||
    (oldOwner &&
      oldOwner.toString() !== (lead.owner || "").toString())
  ) {
    await updateSalesAchieved(lead.owner);
    if (
      oldOwner &&
      oldOwner.toString() !== (lead.owner || "").toString()
    ) {
      await updateSalesAchieved(oldOwner);
    }
  }

  res.json(lead);
});

router.post("/:id/activities", async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) return res.status(404).json({ message: "Lead not found" });
  if (!checkLeadAccess(req, lead))
    return res.status(403).json({ message: "Forbidden" });

  const activity = await Activity.create({
    lead: lead._id,
    user: req.user.id,
    type: req.body.type,
    subject: req.body.subject || "",
    description: req.body.description,
    attachmentUrl: req.body.attachmentUrl,
    createdBy: req.user.id,
  });

  res.status(201).json(activity);
});

router.post("/:id/followups", async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) return res.status(404).json({ message: "Lead not found" });
  if (!checkLeadAccess(req, lead))
    return res.status(403).json({ message: "Forbidden" });

  const followup = await Followup.create({
    lead: lead._id,
    user: req.user.id,
    dueDate: req.body.dueDate,
    status: "pending",
    notes: req.body.notes,
    createdBy: req.user.id,
  });

  lead.nextFollowUpDate = req.body.dueDate;
  await lead.save();

  res.status(201).json(followup);
});

router.delete("/:id", async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) return res.status(404).json({ message: "Lead not found" });
  if (!checkLeadAccess(req, lead))
    return res.status(403).json({ message: "Forbidden" });

  const ownerId = lead.owner;
  await Activity.deleteMany({ lead: lead._id });
  await Followup.deleteMany({ lead: lead._id });
  await lead.deleteOne();

  if (ownerId) {
    await updateSalesAchieved(ownerId);
  }

  res.json({ message: "Lead and related records deleted" });
});

export default router;
