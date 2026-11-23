// ============================================================
//  CabinetFlow — Configuration
//  ------------------------------------------------------------
//  CabinetFlow utilise le MÊME projet Supabase gratuit que
//  WorldLink. La clé « anon » est faite pour être publique :
//  elle peut vivre dans ce fichier sans danger. Ne mets JAMAIS
//  ici la clé « service_role » (elle doit rester secrète).
//
//  OWNER_USER_ID : l'identifiant (UUID) du compte Supabase Auth
//  du propriétaire du produit (Melvin). C'est lui — et lui seul —
//  qui voit la console propriétaire (validation des paiements,
//  liste des cabinets, revenu mensuel). Pour le trouver :
//  Supabase → Authentication → Users → copier l'UUID du compte
//  de Melvin, puis le coller entre les guillemets ci-dessous.
//  Tant qu'il est vide, la console propriétaire reste invisible.
// ============================================================

window.CABINETFLOW_CONFIG = {
  SUPABASE_URL: "https://zocmlehwqebaijqjhpwa.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpvY21sZWh3cWViYWlqcWpocHdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzMTg3OTIsImV4cCI6MjExMDg5NDc5Mn0.C7sC9wawzdeqnLfgG4s2IL9fQu0aLhP08weIHb35gGg",
  OWNER_USER_ID: ""
};
